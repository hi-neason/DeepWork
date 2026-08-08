import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

// 用 node:sqlite 实现的 better-sqlite3 替身（见 src/test/mocks/better-sqlite3.ts），
// 避免加载 Electron ABI 的原生二进制。
import MockSqlite from "../../test/mocks/better-sqlite3";
vi.mock("better-sqlite3", () => ({ default: MockSqlite }));

// 临时数据目录在 mock 工厂内创建，保证模块加载时即捕获到正确路径（避免 TDZ）。
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

describe("storage/db — 增量迁移与 schema", () => {
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

  it("首次打开即创建全部表并补齐记忆子系统列", () => {
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

  it("sessions 表补齐 workspace_dir / root_dir / terminal_cwd / model / group_name", () => {
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
      ]),
    );
  });

  it("automations 表补齐结构化调度列", () => {
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
      ]),
    );
  });

  it("session_groups 表存在", () => {
    const db = getDb();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_groups'")
      .get();
    expect(row).toBeTruthy();
  });

  it("getDb 是单例（多次调用返回同一实例）", () => {
    expect(getDb()).toBe(getDb());
  });

  it("audit() 写入审计日志且不抛错", () => {
    const db = getDb();
    audit({ tool: "unit_test_tool", risk: "read", decision: "allow" });
    const count = (db.prepare("SELECT COUNT(*) c FROM audit_log").get() as any).c;
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("参数化写入可防注入：特殊字符被当作值而非 SQL", () => {
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
    // 表仍完好，说明注入未生效
    const stillThere = db.prepare("SELECT COUNT(*) c FROM memories").get() as any;
    expect(stillThere.c).toBeGreaterThanOrEqual(1);
  });
});
