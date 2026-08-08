import { describe, it, expect, afterEach, vi } from "vitest";
import { createTodosTool, getTodos, clearTodos } from "./todos";

// emitTurnEvent 是 UI 推送副作用，这里隔离掉，只验证 todos 的解析与持久化。
vi.mock("../agent/turnEvents", () => ({ emitTurnEvent: vi.fn() }));

describe("tools/todos", () => {
  afterEach(() => {
    clearTodos("t1");
    clearTodos("t2");
    vi.clearAllMocks();
  });

  it("createTodosTool 解析 schema、默认 pending 并通过 threadId 持久化", async () => {
    const tool = createTodosTool();
    const res = await tool.tool.invoke(
      { todos: [{ content: "a" }, { content: "b", status: "completed" }] },
      { configurable: { thread_id: "t1" } } as any,
    );
    expect(res).toContain("2 todo");
    const saved = getTodos("t1");
    expect(saved).toHaveLength(2);
    expect(saved[0].status).toBe("pending");
    expect(saved[1].status).toBe("completed");
  });

  it("getTodos 对未知 thread 返回空数组", () => {
    expect(getTodos("unknown")).toEqual([]);
  });

  it("clearTodos 清除该 thread 的 todos", async () => {
    const tool = createTodosTool();
    await tool.tool.invoke(
      { todos: [{ content: "x" }] },
      { configurable: { thread_id: "t2" } } as any,
    );
    expect(getTodos("t2")).toHaveLength(1);
    clearTodos("t2");
    expect(getTodos("t2")).toEqual([]);
  });

  it("createTodosTool 拒绝非法 status（schema 校验应失败）", async () => {
    const tool = createTodosTool();
    await expect(
      tool.tool.invoke(
        { todos: [{ content: "x", status: "bogus" }] },
        { configurable: { thread_id: "t1" } } as any,
      ),
    ).rejects.toThrow();
  });
});
