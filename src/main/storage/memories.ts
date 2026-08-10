import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { loadSettings } from "./settings";
import type { MemoryItem, MemoryType } from "../../shared/types";
import { embedText } from "../agent/embedding";

interface MemoryRow {
  id: string;
  content: string;
  scope: string;
  scope_key: string;
  created_at: number;
  embedding: Buffer | null;
  type: string | null;
  importance: number | null;
  status: string | null;
  invalid_at: number | null;
  source: string | null;
}

export interface MemoryAddOpts {
  type?: MemoryType;
  importance?: number;
  source?: string;
}

export interface MemorySearchOpts {
  topK?: number;
  threshold?: number;
  includeInvalid?: boolean;
}

function toItem(r: MemoryRow): MemoryItem {
  return {
    id: r.id,
    content: r.content,
    scope: r.scope as MemoryItem["scope"],
    createdAt: r.created_at,
    type: (r.type as MemoryType) || undefined,
    importance: r.importance == null ? undefined : r.importance,
    status: (r.status as "active" | "invalid") || "active",
    source: r.source || undefined,
  };
}

// ---- embedding helpers -----------------------------------------------------

function toBlob(vec: number[]): Buffer {
  // Allocate an aligned ArrayBuffer then wrap it; Buffer.from(Float32Array)
  // copies the bytes, so the on-disk blob is always 4-aligned on read.
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function fromBlob(buf: Buffer | null): number[] | null {
  if (!buf) return null;
  // Copy into a fresh, 4-byte-aligned ArrayBuffer. Constructing a Float32Array
  // directly over a Buffer slice (buf.buffer, buf.byteOffset) can throw a
  // RangeError when the offset isn't 4-aligned (M-storage③).
  const count = Math.floor(buf.length / 4);
  const aligned = new ArrayBuffer(count * 4);
  buf.copy(Buffer.from(aligned), 0, 0, count * 4);
  return Array.from(new Float32Array(aligned));
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function tokenize(s: string): Set<string> {
  const tokens = s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = new Set<string>();
  for (const tk of tokens) {
    if (/[一-鿿]/.test(tk)) {
      for (const ch of tk) out.add(ch);
    } else out.add(tk);
  }
  return out;
}

function keywordScore(q: string, c: string): number {
  const a = tokenize(q);
  const b = tokenize(c);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  if (inter === 0) return 0;
  return inter / (a.size + b.size - inter);
}

// Best-effort, non-blocking embedding fill so `addMemory` can stay synchronous.
async function backfillEmbedding(id: string, content: string): Promise<void> {
  try {
    const cfg = loadSettings().memory.embedding;
    if (cfg.provider === "none") return;
    const vec = await embedText(content, cfg);
    if (!vec) return;
    getDb()
      .prepare("UPDATE memories SET embedding = ? WHERE id = ?")
      .run(toBlob(vec), id);
  } catch {
    // embedding failure must never break the write path
  }
}

// ---- read ------------------------------------------------------------------

export function listMemories(scopeKey: string): MemoryItem[] {
  const rows = getDb()
    .prepare(
      `SELECT id, content, scope, scope_key, created_at, embedding, type, importance, status, invalid_at, source
       FROM memories
       WHERE (scope = 'global' OR scope_key = ?)
         AND (status IS NULL OR status = 'active')
       ORDER BY created_at ASC`,
    )
    .all(scopeKey) as MemoryRow[];
  return rows.map(toItem);
}

/** List memories for a scope (global + given workspace), optionally by type. For UI. */
export function listMemoriesByScope(
  scopeKey: string,
  type?: MemoryType,
): MemoryItem[] {
  const rows = getDb()
    .prepare(
      `SELECT id, content, scope, scope_key, created_at, embedding, type, importance, status, invalid_at, source
       FROM memories
       WHERE (scope = 'global' OR scope_key = ?)
         AND (status IS NULL OR status = 'active')
         ${type ? "AND type = ?" : ""}
       ORDER BY importance DESC, created_at DESC`,
    )
    .all(...(type ? [scopeKey, type] : [scopeKey])) as MemoryRow[];
  return rows.map(toItem);
}

export function listAllMemories(includeInvalid = false): MemoryItem[] {
  const rows = getDb()
    .prepare(
      `SELECT id, content, scope, scope_key, created_at, embedding, type, importance, status, invalid_at, source
       FROM memories
       WHERE scope = 'global' ${includeInvalid ? "" : "AND (status IS NULL OR status = 'active')"}
       ORDER BY created_at ASC`,
    )
    .all() as MemoryRow[];
  return rows.map(toItem);
}

// ---- write -----------------------------------------------------------------

export function addMemory(
  content: string,
  scopeKey = "",
  opts?: MemoryAddOpts,
): MemoryItem {
  const item: MemoryItem = {
    id: randomUUID(),
    content: content.trim(),
    scope: scopeKey ? "workspace" : "global",
    createdAt: Date.now(),
    type: opts?.type,
    importance: opts?.importance,
    status: "active",
    source: opts?.source,
  };
  getDb()
    .prepare(
      `INSERT INTO memories (id, content, scope, scope_key, created_at, embedding, type, importance, status, invalid_at, source)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'active', NULL, ?)`,
    )
    .run(
      item.id,
      item.content,
      item.scope,
      scopeKey,
      item.createdAt,
      item.type ?? null,
      item.importance ?? null,
      item.source ?? null,
    );
  void backfillEmbedding(item.id, item.content);
  return item;
}

/** Recompute embedding + update content/type/importance. Reactivates if invalid. */
export async function editMemory(
  id: string,
  content: string,
  opts?: MemoryAddOpts,
): Promise<void> {
  const cfg = loadSettings().memory.embedding;
  const text = content.trim();
  const vec = cfg.provider === "none" ? null : await embedText(text, cfg).catch(() => null);
  getDb()
    .prepare(
      `UPDATE memories
       SET content = ?, type = ?, importance = ?, embedding = ?, status = 'active', invalid_at = NULL
       WHERE id = ?`,
    )
    .run(
      text,
      opts?.type ?? null,
      opts?.importance ?? null,
      vec ? toBlob(vec) : null,
      id,
    );
}

/** Soft-invalidate: mark superseded instead of physically deleting (Graphiti-style). */
export function invalidateMemory(id: string): void {
  getDb()
    .prepare("UPDATE memories SET status = 'invalid', invalid_at = ? WHERE id = ?")
    .run(Date.now(), id);
}

/** Restore a soft-invalidated memory without changing its content or source. */
export function restoreMemory(id: string): void {
  getDb().prepare("UPDATE memories SET status = 'active', invalid_at = NULL WHERE id = ?").run(id);
}

export function removeMemory(id: string): void {
  getDb().prepare(`DELETE FROM memories WHERE id = ?`).run(id);
}

// ---- semantic search -------------------------------------------------------

/**
 * Retrieve the most relevant memories for a query. Uses cosine similarity when
 * embeddings are available; otherwise falls back to keyword (Jaccard) scoring.
 * When no embedding backend is configured, returns the top-K by keyword score
 * so injection still stays bounded instead of dumping the whole table.
 */
export async function searchMemories(
  scopeKey: string,
  query: string,
  opts: MemorySearchOpts = {},
): Promise<MemoryItem[]> {
  const topK = opts.topK ?? 10;
  const threshold = opts.threshold ?? 0.45;
  const cfg = loadSettings().memory.embedding;

  const rows = getDb()
    .prepare(
      `SELECT id, content, scope, scope_key, created_at, embedding, type, importance, status, invalid_at, source
       FROM memories
       WHERE (scope = 'global' OR scope_key = ?)
         AND (status IS NULL OR status = 'active')
       ORDER BY created_at DESC`,
    )
    .all(scopeKey) as MemoryRow[];

  if (rows.length === 0) return [];

  const qVec = cfg.provider === "none" ? null : await embedText(query, cfg).catch(() => null);

  const scored = rows.map((r) => {
    const item = toItem(r);
    const score = qVec && r.embedding
      ? cosine(qVec, fromBlob(r.embedding)!)
      : keywordScore(query, r.content);
    return { item, score };
  });

  // Vector mode: hard threshold + top-K. Keyword mode: keep all, top-K only.
  const ranked = scored
    .filter((s) => (qVec ? s.score >= threshold : true))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.item);

  return ranked;
}
