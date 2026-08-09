import { getDb } from "./db";
import type { Session, SessionSource } from "../../shared/types";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import {
  DEFAULT_WORKSPACE_DIR,
  sessionRootDir,
  sessionArtifactsDir,
  hasPickedWorkspace,
} from "../config/paths";
import { logger } from "../log/logger";

/** Internal identifier for the default session group. The display name is
 *  localized via the `sidebar.defaultGroup` i18n key. */
export const DEFAULT_GROUP = "Default";

/** Columns selected when loading a session row (terminal_cwd is derived). */
const SESSION_COLUMNS =
  "id, title, created_at, updated_at, group_name, workspace_dir, root_dir, model, source";

function toSessionSource(v: string | null): SessionSource {
  return v === "automation" ? "automation" : "user";
}

interface SessionRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  group_name: string;
  workspace_dir: string | null;
  root_dir: string | null;
  model: string | null;
  source: string | null;
}

/** Group label derived from a workspace folder: its basename. */
export function groupForWorkspace(workspaceDir?: string | null): string {
  if (!workspaceDir) return DEFAULT_GROUP;
  const base = path.basename(workspaceDir.replace(/[/\\]+$/, ""));
  return base || DEFAULT_GROUP;
}

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    source: toSessionSource(r.source),
    group: r.group_name || groupForWorkspace(r.workspace_dir),
    workspaceDir: r.workspace_dir ?? undefined,
    rootDir: r.root_dir ?? undefined,
    terminalCwd: terminalCwdFor(r.id, r.workspace_dir),
    model: r.model ?? undefined,
  };
}

/**
 * Resolve the terminal's working directory. When a real project folder was
 * picked we open the terminal there; otherwise we fall back to the isolated
 * per-session folder ~/DeepWork/workspace/sessions/<sessionId> so each chat has
 * its own scratch space instead of the shared DeepWork internal directory.
 */
function terminalCwdFor(id: string, workspaceDir?: string | null): string {
  if (hasPickedWorkspace(workspaceDir)) return workspaceDir as string;
  return sessionRootDir(id);
}

/**
 * List sessions. By default returns only user-started chats so the sidebar
 * doesn't show transcripts created by scheduled automations. Pass
 * `includeAutomations: true` to list everything (used by the automation run
 * history when it needs session metadata).
 */
export function listSessions(opts?: { includeAutomations?: boolean }): Session[] {
  const sql = opts?.includeAutomations
    ? `SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY updated_at DESC`
    : `SELECT ${SESSION_COLUMNS} FROM sessions WHERE source != 'automation' ORDER BY updated_at DESC`;
  const rows = getDb().prepare(sql).all() as SessionRow[];
  return rows.map(rowToSession);
}

export function getSession(id: string): Session | null {
  const row = getDb()
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
    .get(id) as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

export function createSession(
  title = "New chat",
  workspaceDir?: string,
  model?: string,
  source: SessionSource = "user",
): Session {
  const now = Date.now();
  const id = randomUUID();
  const base = workspaceDir && workspaceDir.trim() ? workspaceDir : DEFAULT_WORKSPACE_DIR;
  const rootDir = sessionRootDir(id, base);
  const artifactsDir = sessionArtifactsDir(id, base);
  const group = groupForWorkspace(base);
  // Each session gets its own output drawer. For a picked folder it lives under
  // <base>/.deepwork/sessions/<id>/; otherwise it is the isolated root itself.
  try {
    fs.mkdirSync(artifactsDir, { recursive: true });
  } catch (err) {
    logger.error("session", "failed to create session directory", {
      artifactsDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const s: Session = {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    source,
    group,
    workspaceDir: base,
    rootDir,
    terminalCwd: terminalCwdFor(id, base),
    model: model || undefined,
  };
  getDb()
    .prepare(
      `INSERT INTO sessions (id, title, created_at, updated_at, group_name, workspace_dir, root_dir, model, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      s.id,
      s.title,
      s.createdAt,
      s.updatedAt,
      group,
      s.workspaceDir ?? null,
      rootDir,
      model ?? null,
      source,
    );
  ensureGroup(group);
  logger.info("session", "created", {
    id: s.id,
    title: s.title,
    group: s.group,
    workspaceDir: base,
    model: s.model,
    source,
  });
  return s;
}

export function renameSession(id: string, title: string): void {
  getDb()
    .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
    .run(title, Date.now(), id);
}

export function touchSession(id: string): void {
  getDb().prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now(), id);
}

export function deleteSession(id: string): void {
  getDb().prepare("DELETE FROM sessions WHERE id = ?").run(id);
  logger.info("session", "deleted", { id });
}

export function setSessionGroup(id: string, group: string): void {
  const g = group?.trim() || DEFAULT_GROUP;
  getDb().prepare("UPDATE sessions SET group_name = ? WHERE id = ?").run(g, id);
  ensureGroup(g);
}

export function setSessionWorkspace(id: string, workspaceDir: string): void {
  const base = workspaceDir && workspaceDir.trim() ? workspaceDir : DEFAULT_WORKSPACE_DIR;
  const rootDir = sessionRootDir(id, base);
  const artifactsDir = sessionArtifactsDir(id, base);
  const group = groupForWorkspace(base);
  const terminalCwd = terminalCwdFor(id, base);
  try {
    fs.mkdirSync(artifactsDir, { recursive: true });
  } catch (err) {
    console.error("Failed to create session directory:", err);
  }
  getDb()
    .prepare(
      "UPDATE sessions SET workspace_dir = ?, root_dir = ?, terminal_cwd = ?, group_name = ?, updated_at = ? WHERE id = ?",
    )
    .run(base, rootDir, terminalCwd, group, Date.now(), id);
  ensureGroup(group);
}

export function setSessionModel(id: string, model: string | null): void {
  getDb().prepare("UPDATE sessions SET model = ? WHERE id = ?").run(model, id);
}

export function renameGroup(oldName: string, newName: string): void {
  const next = newName?.trim();
  if (!next || next === oldName) return;
  getDb()
    .prepare("UPDATE sessions SET group_name = ? WHERE group_name = ?")
    .run(next, oldName);
  getDb().prepare("DELETE FROM session_groups WHERE name = ?").run(oldName);
  ensureGroup(next);
}

export function deleteGroup(name: string): void {
  if (name === DEFAULT_GROUP) return;
  getDb()
    .prepare("UPDATE sessions SET group_name = ? WHERE group_name = ?")
    .run(DEFAULT_GROUP, name);
  getDb().prepare("DELETE FROM session_groups WHERE name = ?").run(name);
}

function ensureGroup(name: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO session_groups (name, sort_order, created_at) VALUES (?, ?, ?)`,
    )
    .run(name, Date.now(), Date.now());
}

export function createGroup(name: string): void {
  ensureGroup(name.trim() || DEFAULT_GROUP);
}

export function listGroups(): string[] {
  const groups = new Set<string>([DEFAULT_GROUP]);
  const ordered = getDb()
    .prepare(`SELECT name FROM session_groups ORDER BY sort_order ASC`)
    .all() as Array<{ name: string }>;
  for (const r of ordered) groups.add(r.name);
  const fromSessions = getDb()
    .prepare(
      `SELECT group_name, MAX(updated_at) as latest FROM sessions
       GROUP BY group_name ORDER BY latest DESC`,
    )
    .all() as Array<{ group_name: string }>;
  for (const r of fromSessions) groups.add(r.group_name || DEFAULT_GROUP);
  return Array.from(groups);
}
