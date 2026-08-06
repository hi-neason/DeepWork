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
 * The session's working directory = the agent's cwd AND the fs-tool sandbox
 * root. When the user picked a folder, that folder itself is the root so the
 * agent can read the project's source; without a pick we fall back to an
 * isolated per-session folder under the default workspace.
 *
 *   picked:  <base>/                         (the chosen project folder)
 *   default: ~/DeepWork/workspace/sessions/<sessionId>/
 */
export function sessionRootDir(sessionId: string, base?: string): string {
  const picked = base && base.trim();
  if (picked) return path.resolve(picked);
  return path.join(DEFAULT_WORKSPACE_DIR, "sessions", sessionId);
}

/**
 * The per-session output/artifacts drawer. When a folder is picked, produced
 * files go into `<base>/.deepwork/sessions/<sessionId>/` so each session is
 * isolated inside the chosen project while the source tree stays readable.
 * Without a pick the artifacts dir equals the isolated root dir.
 */
export function sessionArtifactsDir(sessionId: string, base?: string): string {
  const picked = base && base.trim();
  if (picked) return path.join(path.resolve(picked), ".deepwork", "sessions", sessionId);
  return path.join(DEFAULT_WORKSPACE_DIR, "sessions", sessionId);
}

/**
 * Whether a workspace base was explicitly chosen (vs. the default fallback).
 * createSession persists DEFAULT_WORKSPACE_DIR even when nothing was picked, so
 * we compare against the resolved default to detect a real project folder.
 */
export function hasPickedWorkspace(base?: string | null): boolean {
  if (!base || !base.trim()) return false;
  return path.resolve(base) !== path.resolve(DEFAULT_WORKSPACE_DIR);
}

/** Legacy Electron userData location used before the ~/DeepWork unification. */
const LEGACY_DATA_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "deepwork",
);

const DB_FILES = ["deepwork.db", "deepwork.db-wal", "deepwork.db-shm", "checkpoints.db", "checkpoints.db-wal", "checkpoints.db-shm"];

/** Ensure all the standard directories exist. Safe to call at startup. */
export function ensureDirs(): void {
  for (const dir of [DEEPWORK_ROOT, APP_DATA_DIR, SKILLS_DIR, DEFAULT_WORKSPACE_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  migrateLegacyData();
}

/**
 * One-time copy of databases from the old ~/Library/Application Support/deepwork
 * location. Only copies a file if the destination doesn't already exist, so an
 * existing ~/DeepWork install is never overwritten.
 */
function migrateLegacyData(): void {
  if (!fs.existsSync(LEGACY_DATA_DIR)) return;
  for (const file of DB_FILES) {
    const src = path.join(LEGACY_DATA_DIR, file);
    const dst = path.join(APP_DATA_DIR, file);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        fs.copyFileSync(src, dst);
      } catch {
        // Best-effort; ignore files that can't be copied.
      }
    }
  }
  // Migrate legacy skills directory if present.
  const legacySkills = path.join(LEGACY_DATA_DIR, "skills");
  if (fs.existsSync(legacySkills)) {
    for (const entry of fs.readdirSync(legacySkills, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dst = path.join(SKILLS_DIR, entry.name);
      if (!fs.existsSync(dst)) {
        try {
          fs.cpSync(path.join(legacySkills, entry.name), dst, { recursive: true });
        } catch {
          // ignore
        }
      }
    }
  }
}
