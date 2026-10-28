import net from 'net';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * PhotoCraft CLI `serve` JSON-RPC (JSON-lines over loopback TCP) client.
 *
 * The real Rust `photocraft-cli serve --port <port>` keeps one headless editing
 * session open and answers `{"id","method","params"}` lines with
 * `{"id","ok","result"|"error"}`. Methods (crates/automation/src/rpc.rs):
 *   - auth {token}                          (first request on each connection)
 *   - engine.execute {command, params?, wait?}
 *   - engine.commands {filter?}             (full registered command registry)
 *   - session.list, doc.open {path}, doc.new {...}, doc.save {path?, format?, quality?},
 *     doc.render {path?, maxSide?}, doc.inspect {index?}, doc.close {index?},
 *     jobs.list / jobs.cancel, batch
 *
 * File I/O is scoped by the automation roots the `serve` process was launched with
 * (`--automation-read-root` / `--automation-write-root`).
 */

export interface ServeRpc {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingHandler {
  resolve: (v: ServeRpc) => void;
  reject: (e: Error) => void;
}

export class PhotocraftServeClient {
  private socket: net.Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<string, PendingHandler>();
  private token: string;
  private port: number;
  private authenticated = false;

  constructor(port?: number, token?: string) {
    this.port = port ?? config.photocraftServePort;
    this.token = token ?? config.photocraftServeToken;
  }

  /** Open (or reuse) the loopback TCP connection, authenticate, and return a ready client. */
  async connect(timeoutMs = 15000): Promise<this> {
    if (this.socket && this.socket.readyState === 'open' && this.authenticated) {
      return this;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    await new Promise<void>((resolve, reject) => {
      const sock = net.connect(this.port, '127.0.0.1');
      sock.setTimeout(timeoutMs);
      this.socket = sock;

      sock.on('connect', () => resolve());
      sock.on('timeout', () => {
        sock.destroy();
        reject(new Error(`photocraft-cli serve connect timeout on 127.0.0.1:${this.port}`));
      });
      sock.on('error', (err) => reject(err));

      sock.on('data', (data) => this.onData(data.toString('utf8')));
      sock.on('close', () => this.onClose());
    });

    // Auth handshake (must be the first request on the connection).
    if (!this.authenticated) {
      const res = await this.rawRequest('auth', { token: this.token });
      if (!res.ok) {
        throw new Error(`photocraft-cli serve auth failed: ${res.error || 'unknown'}`);
      }
      this.authenticated = true;
    }
    return this;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: string | number; ok?: boolean; result?: unknown; error?: string };
        const key = String(msg.id);
        const handler = this.pending.get(key);
        if (handler) {
          this.pending.delete(key);
          handler.resolve({ id: key, ok: !!msg.ok, result: msg.result, error: msg.error });
        }
      } catch (e) {
        logger.warn(`photocraft-cli serve: unparseable reply line: ${line} (${(e as Error).message})`);
      }
    }
  }

  private onClose(): void {
    const err = new Error('photocraft-cli serve connection closed');
    for (const h of this.pending.values()) h.reject(err);
    this.pending.clear();
    this.authenticated = false;
  }

  private rawRequest(method: string, params: unknown, timeoutMs = config.taskTimeout): Promise<ServeRpc> {
    if (!this.socket || this.socket.readyState !== 'open') {
      return Promise.reject(new Error('photocraft-cli serve not connected'));
    }
    const id = String(this.nextId++);
    const payload = JSON.stringify({ id, method, params });
    return new Promise<ServeRpc>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`photocraft-cli serve ${method} timeout (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.socket!.write(payload + '\n');
    });
  }

  /** Run a registered engine command by id (full registry, not a fixed whitelist). */
  async execute(command: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    const res = await this.rawRequest('engine.execute', { command, ...(params ? { params } : {}) });
    if (!res.ok) throw new Error(`engine.execute ${command} failed: ${res.error}`);
    return res.result;
  }

  /** List the full registered command registry (optionally filtered). */
  async listCommands(filter?: string): Promise<unknown[]> {
    await this.connect();
    const res = await this.rawRequest('engine.commands', filter ? { filter } : {}, 30000);
    if (!res.ok) throw new Error(`engine.commands failed: ${res.error}`);
    return Array.isArray(res.result) ? res.result : [];
  }

  async open(path: string): Promise<unknown> {
    await this.connect();
    const res = await this.rawRequest('doc.open', { path });
    if (!res.ok) throw new Error(`doc.open ${path} failed: ${res.error}`);
    return res.result;
  }

  /** Save/export the active document (path is under the write root). */
  async save(path: string, format?: string, quality?: number): Promise<unknown> {
    await this.connect();
    const res = await this.rawRequest('doc.save', { path, ...(format ? { format } : {}), ...(quality ? { quality } : {}) });
    if (!res.ok) throw new Error(`doc.save ${path} failed: ${res.error}`);
    return res.result;
  }

  /** Render the active document to a PNG file (path under the write root) or base64. */
  async render(path?: string, maxSide?: number): Promise<unknown> {
    await this.connect();
    const res = await this.rawRequest('doc.render', { ...(path ? { path } : {}), ...(maxSide ? { maxSide } : {}) });
    if (!res.ok) throw new Error(`doc.render failed: ${res.error}`);
    return res.result;
  }

  async inspect(index?: number): Promise<unknown> {
    await this.connect();
    const res = await this.rawRequest('doc.inspect', index != null ? { index } : {});
    if (!res.ok) throw new Error(`doc.inspect failed: ${res.error}`);
    return res.result;
  }

  async close(index?: number): Promise<unknown> {
    await this.connect();
    const res = await this.rawRequest('doc.close', index != null ? { index } : {});
    if (!res.ok) throw new Error(`doc.close failed: ${res.error}`);
    return res.result;
  }

  closeConnection(): void {
    this.socket?.destroy();
    this.socket = null;
    this.authenticated = false;
  }
}

/** Single shared client for the whole server (serve keeps one headless session). */
export const serveClient = new PhotocraftServeClient();
