import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

import MockSqlite from "../../test/mocks/better-sqlite3";
vi.mock("better-sqlite3", () => ({ default: MockSqlite }));

vi.mock("../config/paths", async (importOriginal) => {
  const f = await import("node:fs");
  const p = await import("node:path");
  const o = await import("node:os");
  const base = f.mkdtempSync(p.join(o.tmpdir(), "dw-mem-"));
  return {
    ...(await importOriginal<typeof import("../config/paths")>()),
    APP_DATA_DIR: base,
    DEFAULT_WORKSPACE_DIR: base,
  };
});

// 记忆检索走 embedding 配置；测试统一用 provider:"none"，落到关键词回退路径。
vi.mock("./settings", () => ({
  loadSettings: () => ({
    memory: { embedding: { provider: "none" }, topK: 5, threshold: 0.1 },
    model: { workspaceDir: "/tmp/workspace" },
  }),
  getApiKey: () => "",
}));

import * as paths from "../config/paths";

describe("storage/memories — CRUD 与语义/关键词检索", () => {
  let mem: typeof import("./memories");
  let tmp: string;
  beforeAll(async () => {
    tmp = paths.APP_DATA_DIR;
    mem = await import("./memories");
  });
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("addMemory 写入并返回带 scope 的条目（workspace vs global）", () => {
    const ws = mem.addMemory("工作区秘密", "ws-1");
    expect(ws.scope).toBe("workspace");
    expect(ws.content).toBe("工作区秘密");
    expect(ws.id).toBeTruthy();

    const g = mem.addMemory("全局偏好");
    expect(g.scope).toBe("global");
  });

  it("listMemories 按 scope_key 过滤（不串工作区）", () => {
    mem.addMemory("A 的工作区条目", "ws-A");
    mem.addMemory("B 的工作区条目", "ws-B");
    const a = mem.listMemories("ws-A").map((m) => m.content);
    expect(a).toContain("A 的工作区条目");
    expect(a).not.toContain("B 的工作区条目");
  });

  it("searchMemories 关键词回退：返回最相关条目", async () => {
    mem.addMemory("React 组件性能优化", "ws-search");
    mem.addMemory("今天天气不错", "ws-search");
    const res = await mem.searchMemories("ws-search", "React 性能", { topK: 5, threshold: 0 });
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].content).toContain("React");
  });

  it("searchMemories 在无匹配时降级不抛错（keyword 模式返回数组、受 topK 约束、不崩溃）", async () => {
    const res = await mem.searchMemories("ws-empty", "zzz没有这种记忆", { topK: 3 });
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBeLessThanOrEqual(3);
  });

  it("invalidateMemory 软失效后不再被 listMemories 列出", () => {
    const item = mem.addMemory("将被废弃的记忆", "ws-inv");
    mem.invalidateMemory(item.id);
    const listed = mem.listMemories("ws-inv").map((m) => m.id);
    expect(listed).not.toContain(item.id);
  });

  it("editMemory 更新内容并重新激活", async () => {
    const item = mem.addMemory("旧内容", "ws-edit");
    mem.invalidateMemory(item.id);
    await mem.editMemory(item.id, "新内容", { type: "fact" });
    const listed = mem.listMemories("ws-edit");
    expect(listed.map((m) => m.content)).toContain("新内容");
  });

  it("removeMemory 物理删除", () => {
    const item = mem.addMemory("临时记忆", "ws-rm");
    mem.removeMemory(item.id);
    expect(mem.listMemories("ws-rm").map((m) => m.id)).not.toContain(item.id);
  });
});
