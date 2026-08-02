import Database from "better-sqlite3";
import { app } from "electron";
import path from "node:path";
import fs from "node:fs";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dir = app.getPath("userData");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "deepwork.db");
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      group_name TEXT NOT NULL DEFAULT '默认'
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session_id TEXT,
      tool TEXT NOT NULL,
      risk TEXT,
      args_preview TEXT,
      decision TEXT,
      output_preview TEXT
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_key);

    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      schedule TEXT NOT NULL,
      run_at TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_run_at INTEGER,
      last_status TEXT
    );

    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      error TEXT,
      session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_automation ON automation_runs(automation_id);
  `);

  // Migration: add group_name to pre-existing sessions tables.
  const cols = d.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "group_name")) {
    d.exec("ALTER TABLE sessions ADD COLUMN group_name TEXT NOT NULL DEFAULT '默认'");
  }

  // Persisted groups (order + rename). A session's group is denormalized onto
  // the session row so listing is a single query; this table just remembers
  // group ordering and empty groups.
  d.exec(`
    CREATE TABLE IF NOT EXISTS session_groups (
      name TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
}

export function audit(entry: {
  sessionId?: string;
  tool: string;
  risk?: string;
  argsPreview?: string;
  decision?: string;
  outputPreview?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO audit_log (ts, session_id, tool, risk, args_preview, decision, output_preview)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      Date.now(),
      entry.sessionId ?? null,
      entry.tool,
      entry.risk ?? null,
      entry.argsPreview ?? null,
      entry.decision ?? null,
      entry.outputPreview ?? null,
    );
}
