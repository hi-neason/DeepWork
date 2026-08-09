import { describe, it, expect, afterEach, vi } from "vitest";
import { createTodosTool, getTodos, clearTodos } from "./todos";

// emitTurnEvent is a UI-push side effect; isolate it here and only verify the
// parsing and persistence of todos.
vi.mock("../agent/turnEvents", () => ({ emitTurnEvent: vi.fn() }));

describe("tools/todos", () => {
  afterEach(() => {
    clearTodos("t1");
    clearTodos("t2");
    vi.clearAllMocks();
  });

  it("createTodosTool parses the schema, defaults to pending, and persists via threadId", async () => {
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

  it("getTodos returns an empty array for an unknown thread", () => {
    expect(getTodos("unknown")).toEqual([]);
  });

  it("clearTodos clears the todos for that thread", async () => {
    const tool = createTodosTool();
    await tool.tool.invoke(
      { todos: [{ content: "x" }] },
      { configurable: { thread_id: "t2" } } as any,
    );
    expect(getTodos("t2")).toHaveLength(1);
    clearTodos("t2");
    expect(getTodos("t2")).toEqual([]);
  });

  it("createTodosTool rejects an invalid status (schema validation should fail)", async () => {
    const tool = createTodosTool();
    await expect(
      tool.tool.invoke(
        { todos: [{ content: "x", status: "bogus" }] },
        { configurable: { thread_id: "t1" } } as any,
      ),
    ).rejects.toThrow();
  });
});
