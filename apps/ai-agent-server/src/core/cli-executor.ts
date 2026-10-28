import path from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { serveClient } from './photocraft-serve.js';

/**
 * PhotoCraft command execution via the real Rust `photocraft-cli serve` gateway.
 *
 * The old Node+sharp shell (`cli/photocraft-cli.mjs`) only knew 18 invented
 * commands and spawned a fresh process per command. This executor instead keeps
 * one headless PhotoCraft session open on `photocraft-cli serve --port <port>`
 * and runs every command through `engine.execute`, so the *full* engine command
 * registry (currently ~920 commands) is available and the agent/harness output is
 * applied to the same document before one export back to the web client.
 *
 * Flow: doc.open(input) → engine.execute(cmd, params)… → doc.save(path) → doc.close.
 */

export interface ExecutionProgress {
  step: number;
  total: number;
  message: string;
  command: string;
  params: Record<string, unknown>;
}

export interface ExecutionResult {
  status: 'success' | 'error';
  outputPath: string;
  logs: string[];
  error?: string;
}

export interface ExecutionCallbacks {
  onProgress?: (progress: ExecutionProgress) => void;
  onLog?: (log: string) => void;
}

/**
 * Path (relative to the automation write root /opt/ai-agent-server) under which the
 * server stores the exported result and serves it back at /processed/<file>.
 */
function resultPath(inputPath: string, index: number): string {
  const base = path.basename(inputPath).replace(/\.(png|webp)$/i, '');
  const ext = path.extname(inputPath).toLowerCase() || '.png';
  // Serve writes under /opt/ai-agent-server/processed. Preserve the input format
  // when the engine can re-encode it losslessly; PNG/WebP stay as-is, others become PNG.
  const finalExt = ['.png', '.webp'].includes(ext) ? ext : '.png';
  return `processed/${base}_result${index}.${finalExt.replace(/^\./, '')}`;
}

/**
 * Apply an ordered list of agent/harness commands to one image through the
 * `photocraft-cli serve` gateway (full registered command registry, not a whitelist).
 */
export async function executeCommands(
  commands: { cmd: string; params: Record<string, unknown> }[],
  imagePath: string,
  callbacks: ExecutionCallbacks = {}
): Promise<ExecutionResult> {
  const logs: string[] = [];
  const log = (s: string): void => {
    logs.push(s);
    callbacks.onLog?.(s);
  };

  // Path as seen by the serve gateway (root = /opt/ai-agent-server). The input lives in
  // uploads/, resolved to a root-relative path for doc.open.
  let relInput = imagePath;
  if (path.isAbsolute(imagePath)) {
    relInput = imagePath.replace(/^\/opt\/ai-agent-server\/?/, '');
  }

  try {
    await serveClient.connect();
    log('Connected to photocraft-cli serve gateway');

    // 1. Open the source document in the headless session.
    const opened = (await serveClient.open(relInput)) as { width?: number; height?: number; name?: string };
    log(`Opened ${opened?.name || relInput} (${opened?.width ?? '?'}×${opened?.height ?? '?'})`);

    // 2. Run every command through engine.execute (validates against the real registry).
    for (let i = 0; i < commands.length; i++) {
      const command = commands[i];
      callbacks.onProgress?.({
        step: i + 1,
        total: commands.length,
        message: `正在执行: ${command.cmd}`,
        command: command.cmd,
        params: command.params,
      });
      log(`→ ${command.cmd} ${JSON.stringify(command.params ?? {})}`);
      await serveClient.execute(command.cmd, command.params ?? {});
      log(`✓ ${command.cmd}`);
    }

    // 3. Export the edited document back to processed/ for the web client.
    const outRel = resultPath(imagePath, Date.now() % 1000);
    await serveClient.save(outRel);
    log(`Saved ${outRel}`);

    // Close this document so the session is ready for the next request.
    try {
      await serveClient.close();
    } catch {
      /* no active doc is fine */
    }

    const outputPath = path.join(config.processedDir, path.basename(outRel));
    logger.info(`photocraft-cli serve: ${commands.length} command(s) applied → ${outputPath}`);
    return { status: 'success', outputPath, logs };
  } catch (err: unknown) {
    const e = err as Error;
    logger.error('photocraft-cli serve execution failed', e);
    const errorMessage = e.message;
    // Best effort: leave the session usable for the next request.
    try {
      await serveClient.close();
    } catch {
      /* ignore */
    }
    return { status: 'error', outputPath: imagePath, logs, error: errorMessage };
  }
}

/**
 * Legacy whitelist validator. With the serve gateway the *real* engine registry is
 * authoritative and rejects unknown commands itself, so this is kept only as a
 * compatibility no-op that always permits (validation happens server-side). Kept so
 * `chat.ts`'s call site still compiles and produces clear serve-sourced errors.
 */
export function validateCommand(_cmd: string, _params: Record<string, unknown>): string | null {
  return null;
}
