import { createMiddleware } from "langchain";
import { loadSettings } from "../storage/settings";
import { listMemories, searchMemories } from "../storage/memories";
import type { MemoryItem } from "../../shared/types";
import { DEFAULT_WORKSPACE_DIR } from "../config/paths";

const PLAN_MODE_REMINDER = `## Plan mode (read-only)
You are in PLAN MODE. You may explore, read files, search, list directories and use
read-only tools. All write/execute/GUI actions are blocked. When you understand the
task, respond with a clear, step-by-step PLAN (commands to run, files to change,
services to touch, and risks), then wait for the user to approve before executing.`;

/**
 * Injects per-turn, non-persisted context into every model call: long-term
 * memories and a plan-mode reminder. We use wrapModelCall (rather than adding
 * messages to the input) so these are not saved into the checkpointer history.
 */
export function createContextMiddleware() {
  return createMiddleware({
    name: "deepwork_context",
    wrapModelCall: async (request: any, handler: any) => {
      const settings = loadSettings();
      const parts: string[] = [];

      const scopeKey = settings.model.workspaceDir || DEFAULT_WORKSPACE_DIR;
      // Semantic retrieval instead of dumping the whole table: rank by the
      // current user query, then inject only the top-K relevant memories.
      const lastUser = [...(request.messages ?? [])]
        .reverse()
        .find((m) => m.role === "user");
      const query =
        typeof lastUser?.content === "string" ? lastUser.content : "";
      let memories: MemoryItem[];
      if (query) {
        memories = await searchMemories(scopeKey, query, {
          topK: settings.memory.topK,
          threshold: settings.memory.threshold,
        });
      } else {
        memories = listMemories(scopeKey);
      }
      if (memories.length > 0) {
        const lines = memories.map((m) => {
          const tag = m.type ? ` (${m.type})` : "";
          return `- ${m.content}${tag}`;
        });
        parts.push(
          "## Long-term memory\n" +
            "These facts were saved in earlier sessions and may be relevant:\n" +
            lines.join("\n"),
        );
      }
      if (settings.permissionMode === "plan") {
        parts.push(PLAN_MODE_REMINDER);
      }

      if (parts.length === 0) return handler(request);

      const ctxMessage = { role: "system", content: parts.join("\n\n") };
      const messages = Array.isArray(request.messages)
        ? [ctxMessage, ...request.messages]
        : request.messages;
      return handler({ ...request, messages });
    },
  });
}
