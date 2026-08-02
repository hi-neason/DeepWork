import { z } from "zod";
import { defineTool } from "./registry";
import { emitTurnEvent } from "../agent/turnEvents";
import type { TodoItem } from "../../shared/types";

// Per-thread todo state (also persisted by langgraph's todoListMiddleware if
// enabled). We keep our own light map so the tool can emit to the UI without
// depending on graph state.
const todosByThread = new Map<string, TodoItem[]>();

const todoSchema = z.object({
  todos: z
    .array(
      z.object({
        content: z.string(),
        status: z.enum(["pending", "in_progress", "completed"]).default("pending"),
      }),
    )
    .describe("The complete, replacement list of todos for this task."),
});

export function createTodosTool() {
  return defineTool(
    "read",
    (args, config) => {
      const parsed = todoSchema.parse(args);
      const threadId: string | undefined = config?.configurable?.thread_id;
      const todos = parsed.todos.map((t) => ({
        content: t.content,
        status: t.status ?? ("pending" as const),
      }));
      if (threadId) {
        todosByThread.set(threadId, todos);
        emitTurnEvent(threadId, { type: "todos_updated", todos });
      }
      return `Saved ${todos.length} todo item(s).`;
    },
    {
      name: "write_todos",
      description:
        "Create or update the task plan as a list of todos. Pass the COMPLETE new list every time (this replaces the previous list). Use this to break a complex task into steps and to track progress as you work. Mark items in_progress when you start them and completed when done.",
      schema: todoSchema,
    },
  );
}

export function getTodos(threadId: string): TodoItem[] {
  return todosByThread.get(threadId) ?? [];
}

export function clearTodos(threadId: string): void {
  todosByThread.delete(threadId);
}
