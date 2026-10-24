/**
 * Muyaya Album API — Node.js Express version
 * ================================================================
 * Local filesystem + SQLite (sql.js - pure JS)
 * 
 * Architecture:
 *   GitHub Pages (muyaya.world) → Nginx → this API (port 3001)
 *   ai-agent-server (port 3000) proxied through Nginx
 * ================================================================
 */

import express from 'express';
import { createRequire } from 'module';
import multer from 'multer';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { initDatabase, getDb, exec, prepare, transaction, saveDatabase, closeDatabase } from './database.js';
import { routeAlbums } from './albums.js';
import { routePublicShare, routeAlbumShare } from './share.js';
import { serveShare } from './share-page.js';
import { createTmpUpload, putTmpBytes, getTmpImage, deleteTmpUpload, sweepExpired } from './tmp.js';
import { getVaultSecret, putVaultSecret, deleteVaultSecret, listVaultSecrets } from './vault-api.js';
import { initVault } from './vault.js';
import { handleGenerate as handleAgnesGenerate } from './agnes.js';
import { handleBodySeg } from './baidu.js';
import { handleClarity, handleColor } from './baidu-enhance.js';
import { handleBeautify } from './megvii.js';
import { handleInpaint } from './volcengine.js';
import { routeAiAgent } from './ai-agent.js';

const require = createRequire(import.meta.url);

// Configuration
const PORT = process.env.PORT || 3001;
const PHOTO_DIR = process.env.PHOTO_DIR || '/opt/muyaya/photos';
const THUMB_DIR = path.join(PHOTO_DIR, 'thumb');
const PREVIEW_DIR = path.join(PHOTO_DIR, 'preview');
const TMP_DIR = process.env.TMP_DIR || '/opt/muyaya/tmp';
const DB_PATH = process.env.DB_PATH || '/opt/muyaya/muyaya.db';
const AUTH_SECRET = process.env.AUTH_SECRET || 'muyaya-secret-key-2026';
const USERS = process.env.USERS || '{}';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'https://muyaya.world,https://xiaobubuya.github.io';

// Ensure directories exist
for (const dir of [PHOTO_DIR, THUMB_DIR, PREVIEW_DIR, TMP_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Database initialization (async)
let db = null;

async function initDb() {
  await initDatabase(DB_PATH);
  db = getDb();
  
  // Initialize schema
  const schema = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf-8');
  exec(schema);
}

initDb().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

// Express app
const app = express();
app.use(cors({
  origin: ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean),
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());

// Static photo serving
app.use('/photos', express.static(PHOTO_DIR));

// Constants
const COOKIE_NAME = 'album_session';
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days
const IMG_SIZES = new Set(['thumb', 'preview']);
const KEY_RE = /^[a-f0-9]{16}$/;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const MAX_BLOB_BYTES = 24 * 1024 * 1024;

// Multer for file uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`)
  }),
  limits: { fileSize: MAX_BLOB_BYTES }
});

// CORS headers helper
function corsHeaders(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : (allowed[0] || ''),
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

// Apply CORS headers to all responses
app.use((req, res, next) => {
  Object.assign(res.headers, corsHeaders(req, res));
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// JSON response helper
function json(res, body, status = 200) {
  return res.status(status).json(body);
}

// Base64 helpers
const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s + '==='.slice((s.length + 3) % 4), 'base64');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// HMAC
async function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

// Session management
async function makeSession(user) {
  const payload = b64url(enc.encode(JSON.stringify({
    u: user,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL
  })));
  const sig = b64url(await hmac(AUTH_SECRET, payload));
  return `${payload}.${sig}`;
}

async function verifySession(req) {
  const raw = req.cookies?.[COOKIE_NAME];
  if (!raw || !AUTH_SECRET) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;

  const expect = b64url(await hmac(AUTH_SECRET, payload));
  if (!timingSafeEqual(sig, expect)) return null;

  try {
    const obj = JSON.parse(new TextDecoder().decode(unb64url(payload)));
    if (!obj.exp || obj.exp * 1000 < Date.now()) return null;
    return obj;
  } catch { return null; }
}

function isHttps(req) {
  return req.protocol === 'https';
}

function sessionCookie(value, secure = true) {
  return `${COOKIE_NAME}=${value}; HttpOnly${secure ? '; Secure' : ''}; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`;
}

function clearCookie(secure = true) {
  return `${COOKIE_NAME}=; HttpOnly${secure ? '; Secure' : ''}; SameSite=Lax; Path=/; Max-Age=0`;
}

// Health check
app.get('/api/health', (req, res) => {
  json(res, { ok: true, ts: Date.now(), storage: 'local' });
});

// Login
app.post('/api/login', async (req, res) => {
  const ip = req.ip || 'unknown';
  
  const since = Date.now() - LOGIN_WINDOW_MS;
  const row = db.prepare(
    'SELECT COUNT(*) as n FROM login_attempts WHERE ip = ? AND ts > ?'
  ).get(ip, since);
  
  if ((row?.n ?? 0) >= LOGIN_MAX_FAILS) {
    return json(res, { error: 'too_many_attempts', retryAfterMs: LOGIN_WINDOW_MS }, 429);
  }

  const user = String(req.body?.user || '').trim();
  const pass = String(req.body?.pass || '');
  let users = {};
  try { users = JSON.parse(USERS); } catch { users = {}; }

  const expected = users[user];
  if (!expected || !timingSafeEqual(pass, expected)) {
    db.prepare('INSERT INTO login_attempts (ip, ts) VALUES (?, ?)').run(ip, Date.now());
    return json(res, { error: 'unauthorized' }, 401);
  }

  db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
  
  res.setHeader('Set-Cookie', sessionCookie(await makeSession(user), isHttps(req)));
  json(res, { ok: true, user });
});

// Logout
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearCookie(isHttps(req)));
  json(res, { ok: true });
});

// Share routes (public)
app.use('/api/share', (req, res, next) => {
  const r = routePublicShare({ method: req.method, path: req.path, request: req, env: {}, cors: corsHeaders(req, res) });
  if (r) {
    res.json(r);
  } else {
    next();
  }
});

// Share page (public)
app.get('/s/:token', async (req, res) => {
  const m = req.path.match(/^\/s\/([a-f0-9]{32})$/);
  if (m) {
    await serveShare(m[1], req, res, {});
  } else {
    res.status(404).send('Not found');
  }
});

// Temp image routes (public)
app.get('/api/tmp/:token', async (req, res) => {
  const m = req.path.match(/^\/api\/tmp\/([a-f0-9]{32})$/);
  if (m) {
    await getTmpImage(m[1], req, res, {});
  } else {
    res.status(404).json({ error: 'not_found' });
  }
});

// Authenticated routes middleware
app.use('/api', async (req, res, next) => {
  // Skip auth for public routes
  const publicPaths = ['/health', '/login', '/logout'];
  if (publicPaths.some(p => req.path.startsWith(p))) return next();
  if (req.path.startsWith('/share/')) return next();
  if (req.path.startsWith('/tmp/')) return next();

  const session = await verifySession(req);
  if (!session) return json(res, { error: 'unauthorized' }, 401);
  
  req.session = session;
  next();
});

// Vault routes
app.get('/api/vault', async (req, res) => {
  await initVault({});
  const result = await listVaultSecrets({}, req, res);
  if (result) return result;
  next();
});

// AI Agent routes
app.use('/api/ai-agent', (req, res, next) => {
  const r = routeAiAgent({
    method: req.method,
    path: `/api/ai-agent${req.path}`,
    request: req,
    env: { AGENT_API_KEY: process.env.AGENT_API_KEY || 'muyaya-secret-key-2026' },
    cors: corsHeaders(req, res),
    session: req.session
  });
  if (r) {
    if (r instanceof Response) {
      // Convert Cloudflare Response to Express
      r.headers.forEach((v, k) => res.setHeader(k, v));
      r.json().then(body => json(res, body, r.status));
    } else {
      Promise.resolve(r).then(body => json(res, body));
    }
  } else {
    next();
  }
});

// AI feature routes (Baidu, Megvii, Volcengine, Agnes)
app.post('/api/agnes/generate', (req, res) => handleAgnesGenerate(req, {}, corsHeaders(req, res)));
app.post('/api/baidu/body-seg', (req, res) => handleBodySeg(req, {}, corsHeaders(req, res)));
app.post('/api/baidu/clarity', (req, res) => handleClarity(req, {}, corsHeaders(req, res)));
app.post('/api/baidu/color', (req, res) => handleColor(req, {}, corsHeaders(req, res)));
app.post('/api/megvii/beautify', (req, res) => handleBeautify(req, {}, corsHeaders(req, res)));
app.post('/api/volcengine/inpaint', (req, res) => handleInpaint(req, {}, corsHeaders(req, res)));

// Temp upload routes
app.post('/api/tmp', (req, res, next) => {
  sweepExpired({}).catch(() => {});
  createTmpUpload(req, req.session, {}, corsHeaders(req, res));
});

// Preset routes
app.get('/api/presets', (req, res) => {
  const result = listPresets(req.session, {}, corsHeaders(req, res));
  res.json(result);
});

app.post('/api/presets', (req, res) => {
  createPreset(req, req.session, {}, corsHeaders(req, res)).then(r => res.json(r));
});

// Photo routes
app.get('/api/photos', (req, res) => {
  listPhotos(req, {}, corsHeaders(req, res)).then(r => res.json(r));
});

app.get('/api/photos/days', (req, res) => {
  listDays({}, corsHeaders(req, res)).then(r => res.json(r));
});

app.post('/api/photos', (req, res) => {
  registerPhoto(req, req.session, {}, corsHeaders(req, res)).then(r => res.json(r));
});

app.get('/api/photos/:key', (req, res) => {
  getPhoto(req.params.key, {}, corsHeaders(req, res)).then(r => res.json(r));
});

app.delete('/api/photos/:key', (req, res) => {
  deletePhoto(req.params.key, {}, corsHeaders(req, res)).then(r => res.json(r));
});

// Blob upload
app.put('/api/blob/:size/:key', upload.single('file'), (req, res) => {
  putBlob(req.params.size, req.params.key, req, req.session, {}, corsHeaders(req, res)).then(r => res.json(r));
});

// Image serving
app.get('/api/img/:size/:key', (req, res) => {
  getImage(req.params.size, req.params.key, req, {}, corsHeaders(req, res));
});

// Album routes
app.use('/api/albums', (req, res, next) => {
  const r = routeAlbums({
    method: req.method,
    path: `/api/albums${req.path}`,
    request: req,
    env: {},
    cors: corsHeaders(req, res),
    session: req.session
  });
  if (r) {
    Promise.resolve(r).then(body => res.json(body));
  } else {
    next();
  }
});

// Album share routes
app.use('/api/albums', (req, res, next) => {
  const r = routeAlbumShare({
    method: req.method,
    path: `/api/albums${req.path}`,
    env: {},
    cors: corsHeaders(req, res),
    session: req.session
  });
  if (r) {
    Promise.resolve(r).then(body => res.json(body));
  } else {
    next();
  }
});

// Me endpoint
app.get('/api/me', (req, res) => {
  json(res, { user: req.session.u });
});

// Preset functions
function listPresets(session, env, cors) {
  const stmt = db.prepare(
    'SELECT id, name, hue, values_json as val_json, created_at as createdAt FROM presets WHERE user = ? ORDER BY created_at DESC'
  );
  const rows = stmt.all(session.u);
  return {
    presets: rows.map(r => {
      let v = {};
      try { v = JSON.parse(r.val_json); } catch { }
      return { id: r.id, name: r.name, hue: r.hue, v, createdAt: r.createdAt };
    })
  };
}

function createPreset(req, session, env, cors) {
  const name = String(req.body?.name || '').trim();
  if (!name) return { error: 'name_required' };
  if (name.length > 50) return { error: 'name_too_long' };

  const v = req.body?.v;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'bad_values' };

  const id = 'user_' + crypto.randomUUID();
  const hue = /^#[0-9a-fA-F]{6}$/.test(String(req.body?.hue || '')) ? String(req.body.hue) : '#f0e8d0';
  
  db.prepare(
    'INSERT INTO presets (id, user, name, hue, values_json) VALUES (?, ?, ?, ?, ?)'
  ).run(id, session.u, name, hue, JSON.stringify(v));

  return { ok: true, id };
}

// Photo functions
function listPhotos(req, env, cors) {
  const limit = Math.min(Number(req.query.limit) || 60, 200);
  const cursor = req.query.cursor;

  const stmt = cursor
    ? db.prepare('SELECT k, w, h, taken_at, taken_day, has_full, pending FROM photos WHERE taken_at < ? ORDER BY taken_at DESC LIMIT ?')
    : db.prepare('SELECT k, w, h, taken_at, taken_day, has_full, pending FROM photos ORDER BY taken_at DESC LIMIT ?');

  const rows = cursor ? stmt.all(cursor, limit) : stmt.all(limit);
  const nextCursor = rows.length === limit ? rows[rows.length - 1].taken_at : null;

  return {
    photos: rows.map(r => ({
      k: r.k, w: r.w, h: r.h,
      takenAt: r.taken_at,
      takenDay: r.taken_day,
      hasFull: !!r.has_full, pending: !!r.pending
    })),
    nextCursor
  };
}

function getPhoto(key, env, cors) {
  if (!KEY_RE.test(key)) return { error: 'bad_key' };
  const row = db.prepare(
    'SELECT k, w, h, taken_at, taken_day, has_full, pending, bytes, uploaded_by, created_at FROM photos WHERE k = ?'
  ).get(key);
  if (!row) return { error: 'not_found' };
  return {
    photo: {
      k: row.k, w: row.w, h: row.h,
      takenAt: row.taken_at,
      takenDay: row.taken_day,
      hasFull: !!row.has_full, pending: !!row.pending,
      bytes: row.bytes,
      uploadedBy: row.uploaded_by,
      createdAt: row.created_at
    }
  };
}

function listDays(env, cors) {
  const rows = db.prepare(
    `SELECT taken_day as day, COUNT(*) as n FROM photos GROUP BY taken_day ORDER BY taken_day DESC`
  ).all();
  return { days: rows.map(r => ({ day: r.day, count: r.n })) };
}

function putBlob(size, key, req, session, env, cors) {
  if (!IMG_SIZES.has(size)) return { error: 'bad_size' };
  if (!KEY_RE.test(key)) return { error: 'bad_key' };

  if (!req.file) return { error: 'no_file' };

  const filePath = req.file.path;
  const content = fs.readFileSync(filePath);
  
  if (content.length === 0) return { error: 'empty_body' };
  if (content.length > MAX_BLOB_BYTES) return { error: 'too_large', max: MAX_BLOB_BYTES, got: content.length };

  const targetDir = size === 'thumb' ? THUMB_DIR : PREVIEW_DIR;
  const targetPath = path.join(targetDir, `${key}.webp`);
  fs.writeFileSync(targetPath, content);

  fs.unlinkSync(filePath);

  return { ok: true, key: `${size}/${key}.webp`, size: content.length };
}

function getImage(size, key, req, env, cors) {
  if (!IMG_SIZES.has(size)) return json(req.res, { error: 'bad_size' }, 400);
  if (!KEY_RE.test(key)) return json(req.res, { error: 'bad_key' }, 400);

  const filePath = path.join(size === 'thumb' ? THUMB_DIR : PREVIEW_DIR, `${key}.webp`);
  
  if (!fs.existsSync(filePath)) {
    return json(req.res, { error: 'not_found' }, 404);
  }

  const content = fs.readFileSync(filePath);
  req.res.setHeader('Content-Type', 'image/webp');
  req.res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  req.res.send(content);
}

function registerPhoto(req, session, env, cors) {
  let b;
  try { b = req.body; } catch { return { error: 'bad_request' }; }

  const list = Array.isArray(b) ? b : [b];
  if (!list.length) return { error: 'empty' };
  if (list.length > 200) return { error: 'too_many', max: 200 };

  const stmts = [];
  for (const p of list) {
    const k = String(p?.k || '');
    if (!KEY_RE.test(k)) return { error: 'bad_key', k };
    const w = Number(p.w) | 0, h = Number(p.h) | 0;
    if (w <= 0 || h <= 0) return { error: 'bad_dimensions', k };

    const takenAt = normalizeDate(p.takenAt);
    const takenDay = localDay(takenAt);
    
    stmts.push({
      k, w, h, taken_at: takenAt, taken_day: takenDay,
      has_full: p.hasFull ? 1 : 0, pending: p.pending ? 1 : 0,
      bytes: Number(p.bytes) | 0, uploaded_by: session.u
    });
  }

  const stmt = db.prepare(`
    INSERT INTO photos (k, w, h, taken_at, taken_day, has_full, pending, bytes, uploaded_by)
    VALUES (@k, @w, @h, @taken_at, @taken_day, @has_full, @pending, @bytes, @uploaded_by)
    ON CONFLICT(k) DO UPDATE SET
      w = @w, h = @h,
      taken_at = @taken_at,
      taken_day = @taken_day,
      has_full = @has_full,
      pending = @pending
  `);

  db.transaction(() => {
    stmts.forEach(s => stmt.run(s));
  })();

  return { ok: true, saved: stmts.length };
}

function normalizeDate(v) {
  if (v) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

const CN_OFFSET_MS = 8 * 60 * 60 * 1000;
function localDay(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return String(iso).slice(0, 10);
  return new Date(t + CN_OFFSET_MS).toISOString().slice(0, 10);
}

function deletePhoto(key, env, cors) {
  if (!KEY_RE.test(key)) return { error: 'bad_key' };
  db.prepare('DELETE FROM photos WHERE k = ?').run(key);
  
  const thumbPath = path.join(THUMB_DIR, `${key}.webp`);
  const previewPath = path.join(PREVIEW_DIR, `${key}.webp`);
  
  try { if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath); } catch {}
  try { if (fs.existsSync(previewPath)) fs.unlinkSync(previewPath); } catch {}
  
  return { ok: true };
}

initDb().then(() => {
  console.log('Database ready, starting server...');
  app.listen(PORT, () => {
    console.log(`Muyaya API listening on port ${PORT}`);
    console.log(`Photo directory: ${PHOTO_DIR}`);
    console.log(`Database: ${DB_PATH}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

export { db };
