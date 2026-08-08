import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { APP_DATA_DIR, DEFAULT_WORKSPACE_DIR } from "../config/paths";
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
  migrate(db);
  return db;
}

function migrate(d: Database.Database): void {
  // Run additive column migrations first, re-reading columns each time, so an
  // older database is brought up to date even if a previous migration run was
  // interrupted.
  const addColumn = (table: string, name: string, decl: string): void => {
    try {
      const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === name)) {
        d.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
      }
    } catch (err) {
      logger.error("db", "migration failed", {
        table,
        column: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      group_name TEXT NOT NULL DEFAULT '默认',
      workspace_dir TEXT,
      root_dir TEXT,
      terminal_cwd TEXT,
      model TEXT
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
      mcp_server_ids TEXT
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

  // Memory subsystem columns (added for the semantic-memory MVP).
  addColumn("memories", "embedding", "BLOB");
  addColumn("memories", "type", "TEXT");
  addColumn("memories", "importance", "REAL");
  addColumn("memories", "status", "TEXT");
  addColumn("memories", "invalid_at", "INTEGER");
  addColumn("memories", "source", "TEXT");

  // Backfill columns on databases created by older builds.
  addColumn("sessions", "group_name", "TEXT NOT NULL DEFAULT '默认'");
  addColumn("sessions", "workspace_dir", "TEXT");
  addColumn("sessions", "root_dir", "TEXT");
  addColumn("sessions", "terminal_cwd", "TEXT");
  addColumn("sessions", "model", "TEXT");

  // Automation subsystem columns (added for structured scheduling).
  addColumn("automations", "updated_at", "INTEGER");
  addColumn("automations", "workspace_dir", "TEXT");
  addColumn("automations", "schedule_type", "TEXT");
  addColumn("automations", "schedule_config", "TEXT");
  addColumn("automations", "valid_from", "TEXT");
  addColumn("automations", "valid_until", "TEXT");
  addColumn("automations", "permission_mode", "TEXT");
  addColumn("automations", "skills", "TEXT");
  addColumn("automations", "mcp_server_ids", "TEXT");
  addColumn("automations", "model", "TEXT");

  // Migration: older builds created each session's working folder directly at
  // <picked>/sessions/<id> and set root_dir to that path. The new layout uses
  // the picked folder itself as cwd/sandbox root and isolates per-session
  // output under <picked>/.deepwork/sessions/<id>. For picked-folder sessions
  // we (1) rewrite root_dir to the picked folder, and (2) move the on-disk
  // folder from <picked>/sessions/<id> to <picked>/.deepwork/sessions/<id>.
  // Default sessions (empty / DEFAULT_WORKSPACE_DIR) keep their isolated layout
  // and are left untouched. Detection is by physical folder existence so this is
  // safe to re-run even after a previous migration rewrote root_dir.
  try {
    const rows = d
      .prepare(
        `SELECT id, workspace_dir, root_dir FROM sessions
         WHERE workspace_dir IS NOT NULL AND workspace_dir != ''
           AND workspace_dir != ?`,
      )
      .all(DEFAULT_WORKSPACE_DIR) as Array<{
      id: string;
      workspace_dir: string;
      root_dir: string | null;
    }>;
    const update = d.prepare(
      "UPDATE sessions SET root_dir = ? WHERE id = ?",
    );
    for (const r of rows) {
      const base = path.resolve(r.workspace_dir);
      const oldDir = path.join(base, "sessions", r.id);
      const newDir = path.join(base, ".deepwork", "sessions", r.id);
      // (1) Move the physical folder if it still lives at the old location.
      if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
        try {
          fs.mkdirSync(path.dirname(newDir), { recursive: true });
          fs.renameSync(oldDir, newDir);
        } catch (err) {
          logger.error("db", "session dir migration failed", {
            oldDir,
            newDir,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // (2) Always ensure root_dir points at the picked folder itself.
      const expected = path.resolve(base);
      if (!r.root_dir || path.resolve(r.root_dir) !== expected) {
        update.run(expected, r.id);
      }
    }
    // Best-effort cleanup: remove the now-empty <picked>/sessions folder so the
    // project tree isn't left with a stray DeepWork artifact directory.
    for (const r of rows) {
      const oldSessionsRoot = path.join(path.resolve(r.workspace_dir), "sessions");
      try {
        if (fs.existsSync(oldSessionsRoot) && fs.readdirSync(oldSessionsRoot).length === 0) {
          fs.rmdirSync(oldSessionsRoot);
        }
      } catch {
        // ignore non-empty or permission errors
      }
    }
  } catch (err) {
    logger.error("db", "root_dir migration failed", {
      error: err instanceof Error ? err.message : String(err),
    });
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
