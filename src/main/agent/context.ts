import { createMiddleware } from "langchain";
import { loadSettings } from "../storage/settings";
import { searchMemories } from "../storage/memories";
import { readRawMemory } from "../storage/user-memory";
import { DEFAULT_WORKSPACE_DIR } from "../config/paths";
import fs from "node:fs";
import path from "node:path";

const PLAN_MODE_REMINDER = `## Plan mode (read-only)
You are in PLAN MODE. You may explore, read files, search, list directories and use
read-only tools. All write/execute/GUI actions are blocked. When you understand the
task, respond with a clear, step-by-step PLAN (commands to run, files to change,
services to touch, and risks), then wait for the user to approve before executing.`;

/**
 * Injects per-turn, non-persisted context into every model call:
 *   1. Global user profile (from memory.md — always injected in full)
 *   2. Workspace-scoped memories (semantic Top-K from SQLite)
 *   3. Plan-mode reminder when applicable
 *
 * We use wrapModelCall so these are not saved into checkpointer history.
 */
export function createContextMiddleware() {
  return createMiddleware({
    name: "deepwork_context",
    wrapModelCall: async (request: any, handler: any) => {
      const settings = loadSettings();
      const parts: string[] = [];

      // --- Global user profile from MD file ---
      const profile = readRawMemory();
      if (profile.trim()) {
        parts.push(
          "## User Profile\n" +
            "The following information about the user was curated by them. " +
            "Treat these as durable facts and preferences.\n\n" +
            profile.trim(),
        );
      }

      // --- Workspace-scoped memories (SQLite, semantic) ---
      const scopeKey = settings.model.workspaceDir || DEFAULT_WORKSPACE_DIR;
      const lastUser = [...(request.messages ?? [])]
        .reverse()
        .find((m) => m.role === "user");
      const query =
        typeof lastUser?.content === "string" ? lastUser.content : "";

      if (query) {
        const workspaceMemories = await searchMemories(scopeKey, query, {
          topK: settings.memory.topK,
          threshold: settings.memory.threshold,
        });
        if (workspaceMemories.length > 0) {
          const lines = workspaceMemories.map((m) => {
            const tag = m.type ? ` (${m.type})` : "";
            return `- ${m.content}${tag}`;
          });
          parts.push(
            "## Workspace context\n" +
              "Facts relevant to this project from past sessions:\n" +
              lines.join("\n"),
          );
        }
      }

      // --- Plan mode ---
      if (settings.permissionMode === "plan") {
        parts.push(PLAN_MODE_REMINDER);
      }

      // --- Project instruction files (AGENTS.md / CLAUDE.md) ---
      const workspaceDir = settings.model.workspaceDir;
      if (workspaceDir) {
        if (settings.includeAgentsMd) {
          const agentsPath = path.join(workspaceDir, "AGENTS.md");
          try {
            const agentsContent = fs.readFileSync(agentsPath, "utf-8");
            if (agentsContent.trim()) {
              parts.push(
                "## Project Instructions (AGENTS.md)\n" + agentsContent.trim(),
              );
            }
          } catch {
            // file not found — skip silently
          }
        }

        if (settings.includeClaudeMd) {
          const claudeFiles = ["CLAUDE.md", "CLAUDE.local.md"];
          const claudeParts: string[] = [];
          for (const f of claudeFiles) {
            const fp = path.join(workspaceDir, f);
            try {
              const content = fs.readFileSync(fp, "utf-8");
              if (content.trim()) {
                claudeParts.push(content.trim());
              }
            } catch {
              // file not found — skip
            }
          }
          if (claudeParts.length > 0) {
            parts.push(
              "## Project Instructions (CLAUDE.md)\n" + claudeParts.join("\n\n"),
            );
          }
        }
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
