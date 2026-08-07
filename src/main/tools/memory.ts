import { z } from "zod";
import type { ToolInterface } from "@langchain/core/tools";
import { defineTool } from "./registry";
import {
  addMemory,
  removeMemory,
  listMemories,
  listMemoriesByScope,
  searchMemories,
  editMemory,
} from "../storage/memories";

/**
 * Long-term memory tools. Facts are stored in SQLite (encrypted at rest via
 * the OS) and injected into the system prompt on every turn. The agent uses
 * these to remember durable user preferences / context across sessions.
 */
export function createMemoryTools(scopeKey = ""): ToolInterface[] {
  const remember = defineTool(
    "read",
    ({ content, type, importance }) => {
      const item = addMemory(content, scopeKey, {
        type,
        importance: typeof importance === "number" ? importance : undefined,
      });
      return `Remembered (id: ${item.id}, type: ${item.type ?? "unspecified"}). It will be available in future sessions.`;
    },
    {
      name: "remember",
      description:
        "Save a durable fact, preference or context about the user or this workspace to long-term memory. Use for information that should persist across conversations, not one-off task details. Be concise and self-contained.",
      schema: z.object({
        content: z.string().describe("A single concise fact to remember (1-2 sentences)."),
        type: z.enum(["preference", "fact", "event"]).optional().describe("Optional classification of the memory."),
        importance: z.number().min(0).max(1).optional().describe("Optional 0..1 importance used for ranking."),
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
    ({ type }) => {
      const items = type ? listMemoriesByScope(scopeKey, type) : listMemories(scopeKey);
      if (items.length === 0) return "No memories stored yet.";
      return items
        .map((m) => `- [${m.id}] (${m.type ?? "fact"}) ${m.content}`)
        .join("\n");
    },
    {
      name: "list_memories",
      description: "List facts held in long-term memory. Optionally filter by type (preference|fact|event).",
      schema: z.object({
        type: z.enum(["preference", "fact", "event"]).optional().describe("Optional type filter."),
      }),
    },
  );

  const searchTool = defineTool(
    "read",
    async ({ query, topK }) => {
      const items = await searchMemories(scopeKey, query, { topK: topK ?? 10 });
      if (items.length === 0) return "No relevant memories found.";
      return items
        .map((m) => `- [${m.id}] (${m.type ?? "fact"}) ${m.content}`)
        .join("\n");
    },
    {
      name: "search_memories",
      description:
        "Semantically search long-term memory for facts relevant to a query. Prefer this over listing everything when you need specific past context.",
      schema: z.object({
        query: z.string().describe("The query to match against stored memories."),
        topK: z.number().optional().describe("Max results (default 10)."),
      }),
    },
  );

  const editTool = defineTool(
    "read",
    async ({ id, content }) => {
      await editMemory(id, content);
      return `Updated memory ${id}.`;
    },
    {
      name: "edit_memory",
      description: "Correct or rewrite a previously remembered fact by id.",
      schema: z.object({
        id: z.string().describe("The id of the memory to edit"),
        content: z.string().describe("The new content for the memory."),
      }),
    },
  );

  return [remember.tool, forget.tool, listMemoriesTool.tool, searchTool.tool, editTool.tool];
}

export { listMemories };
