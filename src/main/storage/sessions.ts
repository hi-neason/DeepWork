import { getDb } from "./db";
import type { Session } from "../../shared/types";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const DEFAULT_GROUP = "默认";

interface SessionRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  group_name: string;
  workspace_dir: string | null;
  model: string | null;
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
    group: r.group_name || groupForWorkspace(r.workspace_dir),
    workspaceDir: r.workspace_dir ?? undefined,
    model: r.model ?? undefined,
  };
}

export function listSessions(): Session[] {
  const rows = getDb()
    .prepare(
      `SELECT id, title, created_at, updated_at, group_name, workspace_dir, model
       FROM sessions ORDER BY updated_at DESC`,
    )
    .all() as SessionRow[];
  return rows.map(rowToSession);
}

export function getSession(id: string): Session | null {
  const row = getDb()
    .prepare(
      `SELECT id, title, created_at, updated_at, group_name, workspace_dir, model
       FROM sessions WHERE id = ?`,
    )
    .get(id) as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

export function createSession(
  title = "New chat",
  workspaceDir?: string,
  model?: string,
): Session {
  const now = Date.now();
  const group = groupForWorkspace(workspaceDir);
  const s: Session = {
    id: randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
    group,
    workspaceDir: workspaceDir || undefined,
    model: model || undefined,
  };
  getDb()
    .prepare(
      `INSERT INTO sessions (id, title, created_at, updated_at, group_name, workspace_dir, model)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(s.id, s.title, s.createdAt, s.updatedAt, group, workspaceDir ?? null, model ?? null);
  ensureGroup(group);
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
}

export function setSessionGroup(id: string, group: string): void {
  const g = group?.trim() || DEFAULT_GROUP;
  getDb().prepare("UPDATE sessions SET group_name = ? WHERE id = ?").run(g, id);
  ensureGroup(g);
}

export function setSessionWorkspace(id: string, workspaceDir: string): void {
  const group = groupForWorkspace(workspaceDir);
  getDb()
    .prepare(
      "UPDATE sessions SET workspace_dir = ?, group_name = ?, updated_at = ? WHERE id = ?",
    )
    .run(workspaceDir, group, Date.now(), id);
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
