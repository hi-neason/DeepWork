import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Use a better-sqlite3 substitute implemented with node:sqlite (see
// src/test/mocks/better-sqlite3.ts) to avoid loading the Electron-ABI native binary.
import MockSqlite from "../../test/mocks/better-sqlite3";
vi.mock("better-sqlite3", () => ({ default: MockSqlite }));

// The temporary data directory is created inside the mock factory so that the
// correct path is captured at module-load time (avoiding the TDZ).
vi.mock("../config/paths", async (importOriginal) => {
  const f = await import("node:fs");
  const p = await import("node:path");
  const o = await import("node:os");
  const base = f.mkdtempSync(p.join(o.tmpdir(), "dw-db-"));
  return {
    ...(await importOriginal<typeof import("../config/paths")>()),
    APP_DATA_DIR: base,
    DEFAULT_WORKSPACE_DIR: base,
  };
});

import * as paths from "../config/paths";

describe("storage/db - schema", () => {
  let getDb: () => any;
  let audit: (e: { tool: string; risk?: string; decision?: string }) => void;
  let tmp: string;
  beforeAll(async () => {
    tmp = paths.APP_DATA_DIR;
    ({ getDb, audit } = await import("./db"));
  });
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("creates all tables and adds the memory-subsystem columns on first open", () => {
    const db = getDb();
    const cols = (t: string) =>
      (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
    expect(cols("memories")).toEqual(
      expect.arrayContaining([
        "id",
        "content",
        "scope",
        "scope_key",
        "created_at",
        "embedding",
        "type",
        "importance",
        "status",
        "invalid_at",
        "source",
      ]),
    );
  });

  it("the sessions table includes workspace_dir / root_dir / terminal_cwd / model / group_name / source", () => {
    const db = getDb();
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "title",
        "workspace_dir",
        "root_dir",
        "terminal_cwd",
        "model",
        "group_name",
        "source",
      ]),
    );
  });

  it("the automations table includes structured scheduling columns", () => {
    const db = getDb();
    const cols = (db.prepare("PRAGMA table_info(automations)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toEqual(
      expect.arrayContaining([
        "schedule_type",
        "schedule_config",
        "valid_from",
        "valid_until",
        "permission_mode",
        "skills",
        "mcp_server_ids",
        "model",
        "updated_at",
        "consecutive_failures",
        "auto_paused",
      ]),
    );
  });

  it("the session_groups table exists", () => {
    const db = getDb();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_groups'")
      .get();
    expect(row).toBeTruthy();
  });

  it("getDb is a singleton (multiple calls return the same instance)", () => {
    expect(getDb()).toBe(getDb());
  });

  it("audit() writes to the audit log without throwing", () => {
    const db = getDb();
    audit({ tool: "unit_test_tool", risk: "read", decision: "allow" });
    const count = (db.prepare("SELECT COUNT(*) c FROM audit_log").get() as any).c;
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("parameterized writes prevent injection: special characters are treated as values, not SQL", () => {
    const db = getDb();
    const evil = "'); DROP TABLE memories; --";
    db.prepare("INSERT INTO memories (id, content, scope, scope_key, created_at) VALUES (?, ?, 'workspace', ?, ?)").run(
      "evt1",
      evil,
      "ws-x",
      1,
    );
    const rows = db.prepare("SELECT content FROM memories WHERE id = ?").all("evt1") as any[];
    expect(rows[0].content).toBe(evil);
    // The table is still intact, proving the injection did not take effect
    const stillThere = db.prepare("SELECT COUNT(*) c FROM memories").get() as any;
    expect(stillThere.c).toBeGreaterThanOrEqual(1);
  });
});
