import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

import MockSqlite from "../../test/mocks/better-sqlite3";
vi.mock("better-sqlite3", () => ({ default: MockSqlite }));

// Fresh temp dir so we plant a LEGACY database before db.ts opens/migrates it.
const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-db-legacy-"));
vi.mock("../config/paths", () => ({
  APP_DATA_DIR: legacyDir,
  DEFAULT_WORKSPACE_DIR: legacyDir,
  DEEPWORK_ROOT: legacyDir,
}));

describe("storage/db - additive column migrations", () => {
  beforeAll(() => {
    // Plant a database from an older schema: sessions table WITHOUT the
    // `source` column (the bug: "no such column: source" on recentFolders).
    const db = new DatabaseSync(path.join(legacyDir, "deepwork.db"));
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        group_name TEXT NOT NULL DEFAULT 'Default',
        workspace_dir TEXT,
        root_dir TEXT,
        model TEXT
      );
      INSERT INTO sessions (id, title, created_at, updated_at, workspace_dir)
      VALUES ('s1', 'old', 1, 1, '/work');
    `);
    db.close();
  });

  afterAll(() => {
    fs.rmSync(legacyDir, { recursive: true, force: true });
  });

  it("adds the missing source column to a legacy sessions table on open", async () => {
    const { getDb } = await import("./db");
    const db = getDb();
    const cols = (
      db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("source");
    // Default value backfills existing rows, and the query that previously
    // threw now runs.
    const row = db
      .prepare(
        `SELECT workspace_dir, MAX(updated_at) AS latest
         FROM sessions WHERE workspace_dir IS NOT NULL AND workspace_dir != ''
         AND source != 'automation'
         GROUP BY workspace_dir ORDER BY latest DESC LIMIT 8`,
      )
      .all() as Array<{ workspace_dir: string }>;
    expect(row).toHaveLength(1);
    expect(row[0].workspace_dir).toBe("/work");
  });
});
