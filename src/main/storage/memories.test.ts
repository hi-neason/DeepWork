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

// Memory retrieval follows the embedding config; tests uniformly use
// provider:"none" to exercise the keyword fallback path.
vi.mock("./settings", () => ({
  loadSettings: () => ({
    memory: { embedding: { provider: "none" }, topK: 5, threshold: 0.1 },
    model: { workspaceDir: "/tmp/workspace" },
  }),
  getApiKey: () => "",
}));

import * as paths from "../config/paths";

describe("storage/memories - CRUD and semantic/keyword retrieval", () => {
  let mem: typeof import("./memories");
  let tmp: string;
  beforeAll(async () => {
    tmp = paths.APP_DATA_DIR;
    mem = await import("./memories");
  });
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("addMemory writes and returns an entry with scope (workspace vs global)", () => {
    const ws = mem.addMemory("工作区秘密", "ws-1");
    expect(ws.scope).toBe("workspace");
    expect(ws.content).toBe("工作区秘密");
    expect(ws.id).toBeTruthy();

    const g = mem.addMemory("全局偏好");
    expect(g.scope).toBe("global");
  });

  it("listMemories filters by scope_key (no cross-workspace leakage)", () => {
    mem.addMemory("A 的工作区条目", "ws-A");
    mem.addMemory("B 的工作区条目", "ws-B");
    const a = mem.listMemories("ws-A").map((m) => m.content);
    expect(a).toContain("A 的工作区条目");
    expect(a).not.toContain("B 的工作区条目");
  });

  it("searchMemories keyword fallback: returns the most relevant entries", async () => {
    mem.addMemory("React 组件性能优化", "ws-search");
    mem.addMemory("今天天气不错", "ws-search");
    const res = await mem.searchMemories("ws-search", "React 性能", { topK: 5, threshold: 0 });
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].content).toContain("React");
  });

  it("searchMemories degrades gracefully without throwing when there is no match (keyword mode returns an array bounded by topK and does not crash)", async () => {
    const res = await mem.searchMemories("ws-empty", "zzz没有这种记忆", { topK: 3 });
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBeLessThanOrEqual(3);
  });

  it("after invalidateMemory soft-invalidates an entry it is no longer listed by listMemories", () => {
    const item = mem.addMemory("将被废弃的记忆", "ws-inv");
    mem.invalidateMemory(item.id);
    const listed = mem.listMemories("ws-inv").map((m) => m.id);
    expect(listed).not.toContain(item.id);
  });

  it("editing content preserves existing type and importance when metadata is omitted", async () => {
    const item = mem.addMemory("before", "", { type: "preference", importance: 0.8 });
    await mem.editMemory(item.id, "after");
    expect(mem.listAllMemories()).toContainEqual(expect.objectContaining({
      id: item.id,
      content: "after",
      type: "preference",
      importance: 0.8,
    }));
  });

  it("editMemory updates content and reactivates the entry", async () => {
    const item = mem.addMemory("旧内容", "ws-edit");
    mem.invalidateMemory(item.id);
    await mem.editMemory(item.id, "新内容", { type: "fact" });
    const listed = mem.listMemories("ws-edit");
    expect(listed.map((m) => m.content)).toContain("新内容");
  });

  it("removeMemory physically deletes the entry", () => {
    const item = mem.addMemory("临时记忆", "ws-rm");
    mem.removeMemory(item.id);
    expect(mem.listMemories("ws-rm").map((m) => m.id)).not.toContain(item.id);
  });
});
