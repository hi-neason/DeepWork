import { getDb } from "./db";
import type { Session } from "../../shared/types";
import { randomUUID } from "node:crypto";

export const DEFAULT_GROUP = "默认";

interface SessionRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  group_name: string;
}

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    group: r.group_name || DEFAULT_GROUP,
  };
}

export function listSessions(): Session[] {
  const rows = getDb()
    .prepare(
      `SELECT id, title, created_at, updated_at, group_name
       FROM sessions ORDER BY updated_at DESC`,
    )
    .all() as SessionRow[];
  return rows.map(rowToSession);
}

export function createSession(title = "New chat", group = DEFAULT_GROUP): Session {
  const now = Date.now();
  const s: Session = {
    id: randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
    group: group || DEFAULT_GROUP,
  };
  getDb()
    .prepare(
      `INSERT INTO sessions (id, title, created_at, updated_at, group_name)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(s.id, s.title, s.createdAt, s.updatedAt, s.group);
  ensureGroup(s.group);
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

/** Rename a group across all its sessions. */
export function renameGroup(oldName: string, newName: string): void {
  const next = newName?.trim();
  if (!next || next === oldName) return;
  getDb()
    .prepare("UPDATE sessions SET group_name = ? WHERE group_name = ?")
    .run(next, oldName);
  getDb().prepare("DELETE FROM session_groups WHERE name = ?").run(oldName);
  ensureGroup(next);
}

/** Delete a group, moving its sessions into the default group. */
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

/** Create an empty group (persisted even with no sessions). */
export function createGroup(name: string): void {
  ensureGroup(name.trim() || DEFAULT_GROUP);
}

/**
 * Distinct groups in display order: the default group first, then groups with
 * an explicit ordering row, then any others seen on sessions (newest activity).
 */
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
