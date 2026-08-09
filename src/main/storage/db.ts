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
  // Run additive column migrations first, re-reading columns each time, so an
  // older database is brought up to date even if a previous migration run was
  // interrupted. A failed column migration is a real problem (disk full,
  // corruption) — logging and continuing would leave the app running on a
  // broken schema and surface as confusing downstream errors, so we collect
  // failures and fail fast after attempting the whole set (M-存储④).
  const migrationFailures: string[] = [];
  const addColumn = (table: string, name: string, decl: string): void => {
    try {
      const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === name)) {
        d.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("db", "migration failed", {
        table,
        column: name,
        error: msg,
      });
      migrationFailures.push(`${table}.${name}: ${msg}`);
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
  addColumn("sessions", "source", "TEXT NOT NULL DEFAULT 'user'");

  // Backfill: sessions created by older builds for scheduled automations were
  // titled with a ⏰ prefix and had no source marker. Reclassify them so they
  // are hidden from the chat list like new automation runs.
  try {
    d.exec(
      `UPDATE sessions SET source = 'automation' WHERE source = 'user' AND title LIKE '⏰ %'`,
    );
  } catch (err) {
    migrationFailures.push(
      `sessions.source backfill: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

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
  // Last scheduled slot (epoch ms) that already fired. Persisted so a restart
  // inside the grace window doesn't double-fire the same slot (M-存储②).
  addColumn("automations", "last_fired_slot", "INTEGER");

  if (migrationFailures.length > 0) {
    // Running on a half-migrated schema is unsafe — every later query is at
    // risk of "no such column" errors that are much harder to diagnose.
    throw new Error(
      `Database schema migration failed for column(s): ${migrationFailures.join("; ")}`,
    );
  }

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
      } catch (err) {
        // Best-effort cleanup: a non-empty or permission-protected folder is
        // not a problem. Log at debug so it is not completely silent (M-存储④).
        logger.warn("db", "could not remove empty legacy sessions folder", {
          oldSessionsRoot,
          error: err instanceof Error ? err.message : String(err),
        });
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
