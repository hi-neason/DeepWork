import type { EmbeddingConfig } from "../../shared/types";
import { logger } from "../log/logger";
import { getApiKey } from "../storage/settings";

// If an embedding backend call fails (e.g. Ollama not running), disable it for
// a cooldown window so we don't hammer the network on every turn.
let unavailableUntil = 0;
const COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Compute an embedding vector for a single text. Returns null when embeddings
 * are disabled or the backend is unreachable (callers fall back to keyword
 * search). Never throws.
 */
export async function embedText(
  text: string,
  cfg: EmbeddingConfig,
): Promise<number[] | null> {
  if (cfg.provider === "none") return null;
  const now = Date.now();
  if (now < unavailableUntil) return null;
  try {
    if (cfg.provider === "ollama") return await embedOllama(text, cfg);
    if (cfg.provider === "openai") return await embedOpenAI(text, cfg);
    return null;
  } catch (err) {
    unavailableUntil = Date.now() + COOLDOWN_MS;
    logger.warn("embedding", "backend unavailable, disabled for 5min", {
      provider: cfg.provider,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function embedOllama(text: string, cfg: EmbeddingConfig): Promise<number[]> {
  const base = (cfg.baseUrl || "http://localhost:11434").replace(/\/$/, "");
  const res = await fetch(base + "/api/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.model, input: [text] }),
  });
  if (!res.ok) throw new Error(`ollama embed HTTP ${res.status}`);
  const data = (await res.json()) as { embeddings?: number[][] };
  const emb = data.embeddings?.[0];
  if (!Array.isArray(emb)) throw new Error("bad ollama embed response");
  return emb;
}

async function embedOpenAI(text: string, cfg: EmbeddingConfig): Promise<number[]> {
  const key = getApiKey("openai") || process.env.OPENAI_API_KEY || "";
  const base = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const res = await fetch(base + "/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ model: cfg.model, input: text }),
  });
  if (!res.ok) throw new Error(`openai embed HTTP ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
  const emb = data.data?.[0]?.embedding;
  if (!Array.isArray(emb)) throw new Error("bad openai embed response");
  return emb;
}
