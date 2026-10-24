-- Muyaya Album Database Schema (SQLite)

CREATE TABLE IF NOT EXISTS photos (
  k TEXT PRIMARY KEY,
  w INTEGER NOT NULL,
  h INTEGER NOT NULL,
  taken_at TEXT NOT NULL,
  taken_day TEXT NOT NULL,
  has_full INTEGER DEFAULT 0,
  pending INTEGER DEFAULT 0,
  bytes INTEGER DEFAULT 0,
  uploaded_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_photos_taken_at ON photos(taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_photos_taken_day ON photos(taken_day);

CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_albums_user ON albums(user);

CREATE TABLE IF NOT EXISTS album_photos (
  album_id TEXT NOT NULL,
  photo_key TEXT NOT NULL,
  position INTEGER DEFAULT 0,
  PRIMARY KEY (album_id, photo_key),
  FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  name TEXT NOT NULL,
  hue TEXT DEFAULT '#f0e8d0',
  values_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_presets_user ON presets(user);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_ts ON login_attempts(ip, ts);

CREATE TABLE IF NOT EXISTS vault_secrets (
  provider TEXT PRIMARY KEY,
  ct TEXT NOT NULL,
  iv TEXT NOT NULL,
  dek TEXT NOT NULL,
  wrap_iv TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS baidu_tokens (
  api_key TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS share_tokens (
  token TEXT PRIMARY KEY,
  album_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
);
