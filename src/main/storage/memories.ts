import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import type { MemoryItem } from "../../shared/types";

interface MemoryRow {
  id: string;
  content: string;
  scope: string;
  scope_key: string;
  created_at: number;
}

function toItem(r: MemoryRow): MemoryItem {
  return {
    id: r.id,
    content: r.content,
    scope: r.scope as MemoryItem["scope"],
    createdAt: r.created_at,
  };
}

export function listMemories(scopeKey: string): MemoryItem[] {
  const rows = getDb()
    .prepare(
      `SELECT id, content, scope, scope_key, created_at FROM memories
       WHERE scope = 'global' OR scope_key = ? ORDER BY created_at ASC`,
    )
    .all(scopeKey) as MemoryRow[];
  return rows.map(toItem);
}

export function listAllMemories(): MemoryItem[] {
  const rows = getDb()
    .prepare(
      `SELECT id, content, scope, scope_key, created_at FROM memories
       WHERE scope = 'global' ORDER BY created_at ASC`,
    )
    .all() as MemoryRow[];
  return rows.map(toItem);
}

export function addMemory(content: string, scopeKey = ""): MemoryItem {
  const item: MemoryItem = {
    id: randomUUID(),
    content: content.trim(),
    scope: scopeKey ? "workspace" : "global",
    createdAt: Date.now(),
  };
  getDb()
    .prepare(
      `INSERT INTO memories (id, content, scope, scope_key, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(item.id, item.content, item.scope, scopeKey, item.createdAt);
  return item;
}

export function removeMemory(id: string): void {
  getDb().prepare(`DELETE FROM memories WHERE id = ?`).run(id);
}
