import { HumanMessage } from "@langchain/core/messages";

import { createChatModel } from "./model";
import { logger } from "../log/logger";
import { loadSettings } from "../storage/settings";
import { renameSession } from "../storage/sessions";

/** Max distinct title-generation chat models kept alive at once (M-Agent③). */
const TITLE_MODEL_CACHE_MAX = 8;

type ChatModel = ReturnType<typeof createChatModel>;

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") out += block.text;
    }
    return out;
  }
  return "";
}

/**
 * Generates chat-list titles independently from the main turn stream.
 *
 * The title request is metadata work, so it pushes `session_renamed` directly
 * through the renderer sender instead of coupling itself to a turn generator.
 */
export class TitleGenerationService {
  private titledSessions = new Set<string>();
  private titleModels = new Map<string, ChatModel>();
  private defaultModel: ChatModel | null = null;
  private send: ((channel: string, ...args: unknown[]) => void) | null = null;

  setDefaultModel(model: ChatModel | null): void {
    this.defaultModel = model;
  }

  setSender(send: (channel: string, ...args: unknown[]) => void): void {
    this.send = send;
  }

  clearCaches(): void {
    this.titleModels.clear();
    this.defaultModel = null;
  }

  forgetSession(sessionId: string): void {
    this.titledSessions.delete(sessionId);
  }

  async maybeGenerateTitle(
    sessionId: string,
    userText: string,
    modelId?: string,
    callbacks?: unknown[],
  ): Promise<void> {
    if (this.titledSessions.has(sessionId)) return;
    this.titledSessions.add(sessionId);
    if (!userText.trim()) return;

    try {
      const model = this.titleModel(modelId);
      if (!model) return;
      const prompt =
        "Generate a short session title from the user's first message for the chat list.\n" +
        "Requirements:\n" +
        "- At most 40 characters\n" +
        "- Summarize the user's main intent or task\n" +
        "- Write the title in the same language as the user's message\n" +
        "- Output only the title itself, with no quotes, numbering, brackets, or explanation\n\n" +
        `User: ${userText.slice(0, 600)}`;
      const t0 = Date.now();
      const stream = await model.stream([new HumanMessage(prompt)], {
        maxTokens: 16,
        temperature: 0,
        ...(callbacks ? { callbacks } : {}),
      } as Record<string, unknown>);
      const parts: string[] = [];
      for await (const chunk of stream) {
        const t = extractText(chunk.content);
        if (t) parts.push(t);
      }
      const title = this.normalizeTitle(parts.join(""));
      if (!title) return;
      this.pushTitle(sessionId, title);
      logger.info(
        "agent",
        "title_ready",
        { session: sessionId, durationMs: Date.now() - t0, title },
        sessionId,
      );
    } catch (err) {
      logger.warn(
        "agent",
        "title_failed",
        { session: sessionId, error: err instanceof Error ? err.message : err },
        sessionId,
      );
    }
  }

  private titleModel(modelId?: string): ChatModel | null {
    if (!modelId) return this.defaultModel;
    const base = loadSettings().model;
    let cfg = base;
    if (modelId.includes(":")) {
      const [p, ...rest] = modelId.split(":");
      cfg = { ...base, provider: p as typeof base.provider, model: rest.join(":") };
    } else {
      cfg = { ...base, model: modelId };
    }
    const key = `${cfg.provider}:${cfg.model}`;
    const cached = this.titleModels.get(key);
    if (cached) return cached;
    const model = createChatModel(cfg);
    this.titleModels.set(key, model);
    if (this.titleModels.size > TITLE_MODEL_CACHE_MAX) {
      const oldest = this.titleModels.keys().next().value;
      if (oldest !== undefined) this.titleModels.delete(oldest);
    }
    return model;
  }

  private normalizeTitle(raw: string): string {
    return raw
      .replace(/^(title)\s*[:：]\s*/i, "")
      .replace(/^[《"「『'“”]+|[》"」』'”]+$/g, "")
      .replace(/^["'\s]+|["'\s]+$/g, "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 40);
  }

  private pushTitle(sessionId: string, title: string): void {
    renameSession(sessionId, title);
    try {
      this.send?.("chat:event", sessionId, { type: "session_renamed", title });
    } catch (err) {
      logger.error(
        "agent",
        "title_send_failed",
        { session: sessionId, error: err instanceof Error ? err.message : err },
        sessionId,
      );
    }
  }
}
