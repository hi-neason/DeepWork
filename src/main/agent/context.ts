import { createMiddleware } from "langchain";
import { loadSettings } from "../storage/settings";
import { searchMemories } from "../storage/memories";
import { readRawMemory } from "../storage/user-memory";
import { readProjectMemory } from "../storage/project-memory";
import { DEFAULT_WORKSPACE_DIR } from "../config/paths";
import type { MemoryItem, PermissionMode } from "../../shared/types";
import fs from "node:fs";
import path from "node:path";

const PLAN_MODE_REMINDER = `## Plan mode (read-only)
You are in PLAN MODE. You may explore, read files, search, list directories and use
read-only tools. All write/execute/GUI actions are blocked. When you understand the
task, respond with a clear, step-by-step PLAN (commands to run, files to change,
services to touch, and risks), then wait for the user to approve before executing.`;

// Project instruction files (AGENTS.md / CLAUDE.md) change rarely but are read on
// every model call. Cache their contents keyed by (path, mtimeMs, size) so we
// only re-read when the file actually changes on disk (M-Agent③). A failed stat
// is cached as a miss so a missing file doesn't cost a throw per call.
interface MdCacheEntry {
  mtimeMs: number;
  size: number;
  content: string | null;
}
const mdCache = new Map<string, MdCacheEntry>();

function readProjectMd(filePath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    mdCache.set(filePath, { mtimeMs: -1, size: -1, content: null });
    return null;
  }
  const cached = mdCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.content;
  }
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const trimmed = content.trim();
    const value = trimmed || null;
    mdCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, content: value });
    return value;
  } catch {
    mdCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, content: null });
    return null;
  }
}

/**
 * Injects per-turn, non-persisted context into every model call:
 *   1. Global user profile (from memory.md — always injected in full)
 *   2. Workspace-scoped memories (semantic Top-K from SQLite)
 *   3. Plan-mode reminder when applicable
 *
 * We use wrapModelCall so these are not saved into checkpointer history.
 */
// Pure helper: pull the latest user turn's text to seed semantic memory search.
// LangChain `BaseMessage` instances carry the role via `getType()` (or the
// serialized `type`/`role` field), NOT a `role` property on plain objects — so
// we accept both shapes. Content may be a string or a blocks[] array.
function messageIsHuman(m: any): boolean {
  if (!m || typeof m !== "object") return false;
  if (typeof m.getType === "function") {
    const t = m.getType();
    if (t === "human" || t === "humanmessage") return true;
  }
  if (typeof m._getType === "function") {
    if (m._getType() === "human") return true;
  }
  const role = m.role ?? m.type;
  return role === "user" || role === "human";
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && b.type === "text" && typeof b.text === "string" ? b.text : "",
      )
      .join("");
  }
  return "";
}

export function extractLastUserQuery(messages: any[] | undefined): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messageIsHuman(messages[i])) {
      return messageText(messages[i].content);
    }
  }
  return "";
}

/** Explain each retrieved item in the prompt without exposing implementation details. */
export function formatRetrievedMemories(memories: MemoryItem[]): string[] {
  return memories.map((memory) => {
    const type = memory.type ?? "fact";
    const source = memory.source ? `; source: ${memory.source}` : "";
    return `- [memory:${memory.id}; ${type}${source}] ${memory.content}`;
  });
}

export function createContextMiddleware(deps: {
  getMode: (threadId?: string) => PermissionMode;
  getWorkspace: (threadId?: string) => string | undefined;
  getProjectWorkspace: (threadId?: string) => string | undefined;
}) {
  const { getMode, getWorkspace, getProjectWorkspace } = deps;
  return createMiddleware({
    name: "deepwork_context",
    wrapModelCall: async (request: any, handler: any) => {
      const settings = loadSettings();
      const threadId =
        request.runtime?.configurable?.thread_id ??
        request.runtime?.config?.configurable?.thread_id ??
        request.config?.configurable?.thread_id;
      const mode = getMode(threadId);
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
      const workspaceDir = getWorkspace(threadId) || settings.model.workspaceDir || DEFAULT_WORKSPACE_DIR;
      const scopeKey = workspaceDir;
      const query = extractLastUserQuery(request.messages);

      if (query) {
        const workspaceMemories = await searchMemories(scopeKey, query, {
          topK: settings.memory.topK,
          threshold: settings.memory.threshold,
        });
        if (workspaceMemories.length > 0) {
          parts.push(
            "## Workspace context\n" +
              "Facts relevant to this project from past sessions. Each entry includes its retrieval provenance:\n" +
              formatRetrievedMemories(workspaceMemories).join("\n"),
          );
        }
      }

      // --- Project memory (daily distilled decisions and work history) ---
      const projectWorkspace = getProjectWorkspace(threadId);
      if (projectWorkspace) {
        const project = path.basename(projectWorkspace);
        const projectMemory = readProjectMemory(project).trim();
        if (projectMemory) {
          // Project memory grows indefinitely; retain the newest portion without
          // crowding out the live task and semantic retrieval context.
          const recent = projectMemory.slice(0, 12_000);
          parts.push(
            "## Project memory\n" +
              "Distilled decisions and work history for this project:\n\n" +
              recent,
          );
        }
      }

      // --- Plan mode ---
      if (mode === "plan") {
        parts.push(PLAN_MODE_REMINDER);
      }

      // --- Project instruction files (AGENTS.md / CLAUDE.md) ---
      if (workspaceDir) {
        if (settings.includeAgentsMd) {
          const agentsContent = readProjectMd(path.join(workspaceDir, "AGENTS.md"));
          if (agentsContent) {
            parts.push("## Project Instructions (AGENTS.md)\n" + agentsContent);
          }
        }

        if (settings.includeClaudeMd) {
          const claudeFiles = ["CLAUDE.md", "CLAUDE.local.md"];
          const claudeParts: string[] = [];
          for (const f of claudeFiles) {
            const content = readProjectMd(path.join(workspaceDir, f));
            if (content) claudeParts.push(content);
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
