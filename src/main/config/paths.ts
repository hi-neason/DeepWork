import path from "node:path";
import os from "node:os";
import fs from "node:fs";

/**
 * Single on-disk root for all of DeepWork's local state. Everything the app
 * stores lives under ~/DeepWork, while a user can still point an individual
 * session at an arbitrary workspace folder.
 *
 *   ~/DeepWork/
 *     app/         databases (settings, sessions, memories, checkpoints…), caches
 *     skills/      local SKILL.md packs (one subdirectory per skill)
 *     workspace/   default workspace for sessions without a chosen folder
 */
export const DEEPWORK_ROOT = path.join(os.homedir(), "DeepWork");
export const APP_DATA_DIR = path.join(DEEPWORK_ROOT, "app");
export const SKILLS_DIR = path.join(DEEPWORK_ROOT, "skills");
export const DEFAULT_WORKSPACE_DIR = path.join(DEEPWORK_ROOT, "workspace");

/**
 * Unified root for all memory stores. Everything long-term the assistant
 * remembers lives under ~/DeepWork/memory so the layout is predictable:
 *
 *   ~/DeepWork/memory/
 *     user/           personal curated memory (user_memory.md)
 *     timeline_memory/  one file per day (2026-08-08.md)
 *     project_memory/   one file per project (reserved, not yet used)
 */
export const MEMORY_ROOT = path.join(DEEPWORK_ROOT, "memory");
export const USER_MEMORY_DIR = path.join(MEMORY_ROOT, "user");
export const TIMELINE_MEMORY_DIR = path.join(MEMORY_ROOT, "timeline_memory");
export const PROJECT_MEMORY_DIR = path.join(MEMORY_ROOT, "project_memory");

/**
 * The session-owned workspace used by artifacts and the embedded terminal.
 * A selected project keeps session output under its private .deepwork drawer;
 * without a selection the configured default workspace owns a sessions folder.
 *
 *   picked:  <project>/.deepwork/sessions/<sessionId>/
 *   default: <defaultWorkspace>/sessions/<sessionId>/
 */
export function sessionRootDir(
  sessionId: string,
  projectDir?: string,
  defaultWorkspaceDir = DEFAULT_WORKSPACE_DIR,
): string {
  if (hasPickedWorkspace(projectDir)) {
    return path.join(path.resolve(projectDir!), ".deepwork", "sessions", sessionId);
  }
  const base = defaultWorkspaceDir?.trim()
    ? path.resolve(defaultWorkspaceDir)
    : DEFAULT_WORKSPACE_DIR;
  return path.join(base, "sessions", sessionId);
}

/**
 * The per-session output/artifacts drawer. When a folder is picked, produced
 * files go into `<base>/.deepwork/sessions/<sessionId>/` so each session is
 * isolated inside the chosen project while the source tree stays readable.
 * Without a pick the artifacts dir equals the isolated root dir.
 */
export function sessionArtifactsDir(
  sessionId: string,
  projectDir?: string,
  defaultWorkspaceDir = DEFAULT_WORKSPACE_DIR,
): string {
  return sessionRootDir(sessionId, projectDir, defaultWorkspaceDir);
}

/**
 * Whether a workspace base was explicitly chosen (vs. the default fallback).
 * New sessions persist only an explicitly selected project here. Legacy rows
 * that stored DEFAULT_WORKSPACE_DIR are normalized by the session store.
 */
export function hasPickedWorkspace(base?: string | null): boolean {
  return Boolean(base?.trim());
}

/** Ensure all the standard directories exist. Safe to call at startup. */
export function ensureDirs(): void {
  for (const dir of [
    DEEPWORK_ROOT,
    APP_DATA_DIR,
    SKILLS_DIR,
    DEFAULT_WORKSPACE_DIR,
    MEMORY_ROOT,
    USER_MEMORY_DIR,
    TIMELINE_MEMORY_DIR,
    PROJECT_MEMORY_DIR,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
