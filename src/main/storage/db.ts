import Database from "better-sqlite3";
import path from "node:path";
import { APP_DATA_DIR } from "../config/paths";
import { logger } from "../log/logger";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const file = path.join(APP_DATA_DIR, "deepwork.db");
  try {
    db = new Database(file);
  } catch (err) {
    logger.error("db", "failed to open database", {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  db.pragma("journal_mode = WAL");
  // Wait up to 5s if another process/connection holds a write lock, instead of
  // throwing SQLITE_BUSY immediately. Enforce foreign keys (currently no
  // cross-table FKs, but future-proof). L-3.
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  try {
    migrate(db);
  } catch (err) {
    // Migration is fail-fast: a half-migrated schema is unsafe to run on. Close
    // the handle and reset so the failure isn't masked by a cached broken db.
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
    throw err;
  }
  return db;
}

/** Flush + close the database cleanly (call on app quit). L-3. */
export function closeDb(): void {
  if (!db) return;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  } catch (err) {
    logger.error("db", "close failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    db = null;
  }
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      group_name TEXT NOT NULL DEFAULT 'Default',
      workspace_dir TEXT,
      root_dir TEXT,
      terminal_cwd TEXT,
      model TEXT,
      source TEXT NOT NULL DEFAULT 'user'
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
      created_at INTEGER NOT NULL,
      embedding BLOB,
      type TEXT,
      importance REAL,
      status TEXT,
      invalid_at INTEGER,
      source TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_key);

    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      last_run_at INTEGER,
      last_status TEXT,
      workspace_dir TEXT,
      schedule_type TEXT,
      schedule_config TEXT,
      valid_from TEXT,
      valid_until TEXT,
      permission_mode TEXT,
      skills TEXT,
      mcp_server_ids TEXT,
      model TEXT,
      last_fired_slot INTEGER,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      auto_paused INTEGER NOT NULL DEFAULT 0
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

    CREATE TABLE IF NOT EXISTS session_groups (
      name TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  // Pre-release builds can still have an earlier local schema. Keep these
  // additions idempotent so failure safeguards take effect without data loss.
  ensureColumn(d, "automations", "consecutive_failures", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(d, "automations", "auto_paused", "INTEGER NOT NULL DEFAULT 0");
}

function ensureColumn(d: Database.Database, table: string, column: string, definition: string): void {
  const columns = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
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
