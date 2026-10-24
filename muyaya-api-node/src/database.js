/**
 * SQLite database wrapper using sql.js (pure JS, no native compilation)
 */

import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';

let db = null;
let dbPath = null;
let saveTimer = null;

export async function initDatabase(dbPath_) {
  dbPath = dbPath_;
  const SQL = await initSqlJs();
  
  if (fs.existsSync(dbPath_)) {
    const buffer = fs.readFileSync(dbPath_);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  
  console.log(`Database initialized at ${dbPath_}`);
}

export function getDb() {
  return db;
}

export function exec(sql) {
  db.exec(sql);
  scheduleSave();
}

export function prepare(sql) {
  return {
    get: (...params) => {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      if (stmt.step()) {
        const columns = stmt.getColumnNames();
        const values = stmt.get();
        stmt.free();
        const row = {};
        columns.forEach((col, i) => { row[col] = values[i]; });
        return row;
      }
      stmt.free();
      return undefined;
    },
    all: (...params) => {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) {
        const columns = stmt.getColumnNames();
        const values = stmt.get();
        const row = {};
        columns.forEach((col, i) => { row[col] = values[i]; });
        rows.push(row);
      }
      stmt.free();
      return rows;
    },
    run: (...params) => {
      db.run(sql, params);
      scheduleSave();
      return { changes: 1 };
    }
  };
}

export function transaction(fn) {
  db.exec('BEGIN TRANSACTION');
  try {
    fn();
    db.exec('COMMIT');
    scheduleSave();
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveDatabase();
  }, 1000);
}

export function saveDatabase() {
  if (!db || !dbPath) return;
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
  console.log('Database saved');
}

export async function closeDatabase() {
  if (db) {
    saveDatabase();
    db.close();
  }
}
