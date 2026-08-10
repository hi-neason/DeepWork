import { z } from "zod";
import type { ToolInterface } from "@langchain/core/tools";
import { defineTool } from "./registry";
import {
  listMemories,
  listMemoriesByScope,
  searchMemories,
} from "../storage/memories";
import {
  appendToRecent,
  readRawMemory,
  readUserMemory,
} from "../storage/user-memory";

/**
 * Long-term memory tools.
 *
 * Global user memory lives in a hand-curated markdown file (memory.md).
 * Workspace-scoped project memories live in SQLite with semantic retrieval.
 *
 * The agent uses these tools to persist context across sessions.
 */
export function createMemoryTools(scopeKey = ""): ToolInterface[] {
  const remember = defineTool(
    "read",
    ({ content }) => {
      // Always append to the global user profile's "recent" section.
      // The agent decides what's worth keeping; the user curates later.
      appendToRecent(content, "agent");
      return "Saved to your profile (Recent updates). It will be available in future sessions.";
    },
    {
      name: "remember",
      description:
        "Save a durable fact, preference or context about the user to their long-term profile. Use for information that should persist across conversations — e.g. user preferences, background facts, decisions made. Be concise and self-contained. This appends to the 'Recent updates' section of the user's memory file.",
      schema: z.object({
        content: z.string().describe("A single concise fact to remember (1-2 sentences)."),
      }),
    },
  );

  const listMemoriesTool = defineTool(
    "read",
    () => {
      const raw = readRawMemory();
      if (!raw.trim()) return "No user profile stored yet.";
      return `## User Profile\n${raw.trim()}`;
    },
    {
      name: "list_memories",
      description: "Show the full user profile (personal background, work style, focus areas, recent updates). This is the user's curated long-term memory.",
      schema: z.object({}),
    },
  );

  const searchWorkspaceTool = defineTool(
    "read",
    async ({ query, topK }) => {
      const items = await searchMemories(scopeKey, query, { topK: topK ?? 10 });
      if (items.length === 0) return "No relevant workspace memories found.";
      return items
        .map((m) => {
          const source = m.source ? `; source: ${m.source}` : "";
          return `- [${m.id}; ${m.type ?? "fact"}${source}] ${m.content}`;
        })
        .join("\n");
    },
    {
      name: "search_workspace_memories",
      description:
        "Search project-specific memories stored for this workspace. These are auto-extracted facts about the current project, separate from the user's global profile.",
      schema: z.object({
        query: z.string().describe("The query to match against workspace memories."),
        topK: z.number().optional().describe("Max results (default 10)."),
      }),
    },
  );

  return [remember.tool, listMemoriesTool.tool, searchWorkspaceTool.tool];
}

export { listMemories };
