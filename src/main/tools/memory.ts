import { z } from "zod";
import type { ToolInterface } from "@langchain/core/tools";
import { defineTool } from "./registry";
import { addMemory, removeMemory, listMemories } from "../storage/memories";

/**
 * Long-term memory tools. Facts are stored in SQLite (encrypted at rest via
 * the OS) and injected into the system prompt on every turn. The agent uses
 * these to remember durable user preferences / context across sessions.
 */
export function createMemoryTools(scopeKey = ""): ToolInterface[] {
  const remember = defineTool(
    "read",
    ({ content }) => {
      const item = addMemory(content, scopeKey);
      return `Remembered (id: ${item.id}). It will be available in future sessions.`;
    },
    {
      name: "remember",
      description:
        "Save a durable fact, preference or context about the user or this workspace to long-term memory. Use for information that should persist across conversations, not one-off task details. Be concise and self-contained.",
      schema: z.object({
        content: z.string().describe("A single concise fact to remember (1-2 sentences)."),
      }),
    },
  );

  const forget = defineTool(
    "read",
    ({ id }) => {
      removeMemory(id);
      return `Forgot memory ${id}.`;
    },
    {
      name: "forget",
      description: "Delete a previously remembered fact by its id.",
      schema: z.object({
        id: z.string().describe("The id of the memory to forget"),
      }),
    },
  );

  const listMemoriesTool = defineTool(
    "read",
    () => {
      const items = listMemories(scopeKey);
      if (items.length === 0) return "No memories stored yet.";
      return items.map((m) => `- [${m.id}] ${m.content}`).join("\n");
    },
    {
      name: "list_memories",
      description: "List all facts currently held in long-term memory.",
      schema: z.object({}),
    },
  );

  return [remember.tool, forget.tool, listMemoriesTool.tool];
}

export { listMemories };
