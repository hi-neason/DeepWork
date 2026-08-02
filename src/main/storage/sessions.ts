import { getDb } from "./db";
import type { Session } from "../../shared/types";
import { randomUUID } from "node:crypto";

export function listSessions(): Session[] {
  return getDb()
    .prepare("SELECT id, title, created_at as createdAt, updated_at as updatedAt FROM sessions ORDER BY updated_at DESC")
    .all() as Session[];
}

export function createSession(title = "New chat"): Session {
  const now = Date.now();
  const s: Session = { id: randomUUID(), title, createdAt: now, updatedAt: now };
  getDb()
    .prepare("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(s.id, s.title, s.createdAt, s.updatedAt);
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
  const d = getDb();
  d.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}
