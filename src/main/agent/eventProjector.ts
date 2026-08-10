import { EventEmitter } from "node:events";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { logger } from "../log/logger";

/** Flatten any message content (string | block[] | object) into plain text, truncated. */
function previewText(content: unknown, max = 800): string {
  const strProp = (o: unknown, key: string): string | undefined => {
    if (o && typeof o === "object") {
      const v = (o as Record<string, unknown>)[key];
      return typeof v === "string" ? v : undefined;
    }
    return undefined;
  };
  let out = "";
  if (typeof content === "string") out = content;
  else if (Array.isArray(content)) {
    for (const b of content) {
      out += strProp(b, "text") ?? strProp(b, "thinking") ?? strProp(b, "reasoning") ?? "";
      const image = strProp(b, "image_url");
      if (image) out += `[image:${image.slice(0, 80)}]`;
    }
  } else {
    try { out = JSON.stringify(content); } catch { out = String(content); }
  }
  return out.length > max ? out.slice(0, max) + "…" : out;
}

function preview(v: unknown, max = 500): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch {
    return String(v).slice(0, max);
  }
}

function extractUsage(llmOutput: any): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} | undefined {
  if (!llmOutput) return undefined;
  const u = llmOutput.usage ?? llmOutput.token_usage ?? llmOutput.tokenUsage;
  if (!u) return undefined;
  const inputTokens = u.input_tokens ?? u.prompt_tokens ?? 0;
  const outputTokens = u.output_tokens ?? u.completion_tokens ?? 0;
  const totalTokens = u.total_tokens ?? inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function extractFinishReason(output: any): string | undefined {
  const g = output?.generations?.[0]?.[0];
  return (
    g?.generationInfo?.finish_reason ??
    g?.message?.response_metadata?.finish_reason ??
    output?.llmOutput?.finish_reason ??
    undefined
  );
}

/** Coarse serialized size of an object, in characters. */
function estSize(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Stringify without throwing on circular refs (tools sometimes return those). */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

export class EventProjector extends BaseCallbackHandler {
  name = "deepwork-logger";
  private startedAt = new Map<string, number>();
  private reasoningPhaseOpen = false;
  totals = { inputTokens: 0, outputTokens: 0, calls: 0 };

  constructor(
    private readonly sessionId: string,
    private readonly emitter?: EventEmitter,
  ) {
    super();
  }

  handleLLMStart(llm: any, prompts: string[], runId: string): void {
    const id = Array.isArray(llm?.id) ? llm.id : [];
    const provider = id[2] ?? id.at(-1);
    const model = llm?.kwargs?.model ?? id.at(-1);
    this.startedAt.set(runId, Date.now());
    if (this.emitter) {
      if (this.reasoningPhaseOpen) {
        this.emitter.emit("event", { type: "reasoning_phase_finished", phase: "tool" });
      }
      this.emitter.emit("event", { type: "reasoning_phase_started" });
      this.reasoningPhaseOpen = true;
      logger.debug("agent", "reasoning_phase_started", { session: this.sessionId, runId, model }, this.sessionId);
    }
    logger.info(
      "llm",
      "call_start",
      {
        session: this.sessionId,
        runId,
        provider,
        model,
        promptChars: prompts?.reduce((a, p) => a + (p?.length ?? 0), 0) ?? 0,
      },
      this.sessionId,
    );
    if (Array.isArray(prompts) && prompts.length) {
      logger.debug(
        "llm",
        "prompt",
        {
          session: this.sessionId,
          runId,
          model,
          prompts: prompts.map((p, i) => ({
            index: i,
            len: p?.length ?? 0,
            text: typeof p === "string" ? p : String(p),
          })),
        },
        this.sessionId,
      );
    }
  }

  handleLLMEnd(output: any, runId: string): void {
    const start = this.startedAt.get(runId);
    const latencyMs = start ? Date.now() - start : undefined;
    this.startedAt.delete(runId);
    const usage = extractUsage(output?.llmOutput);
    const model = output?.llmOutput?.model ?? undefined;
    const finishReason = extractFinishReason(output);
    if (this.emitter && this.reasoningPhaseOpen) {
      const phase = finishReason === "tool_calls" ? "tool" : "final";
      this.emitter.emit("event", { type: "reasoning_phase_finished", phase });
      this.reasoningPhaseOpen = false;
      logger.debug("agent", "reasoning_phase_finished", { session: this.sessionId, runId, finishReason, phase }, this.sessionId);
    }
    if (usage) {
      this.totals.inputTokens += usage.inputTokens;
      this.totals.outputTokens += usage.outputTokens;
      this.totals.calls += 1;
    }
    logger.info(
      "llm",
      "call_end",
      {
        session: this.sessionId,
        runId,
        model,
        finishReason,
        latencyMs,
        usage,
      },
      this.sessionId,
    );
    const gens = output?.generations?.[0]?.[0];
    let respText = "";
    if (gens) {
      if (typeof gens.text === "string") respText = gens.text;
      else if (gens.message?.content != null) respText = previewText(gens.message.content, 100000);
    }
    if (respText.length > 0) {
      logger.debug(
        "llm",
        "call_output",
        {
          session: this.sessionId,
          runId,
          model,
          finishReason,
          latencyMs,
          responseLen: respText.length,
          responsePreview: previewText(respText, 800),
        },
        this.sessionId,
      );
    }
  }

  handleLLMError(err: any, runId: string): void {
    const start = this.startedAt.get(runId);
    const latencyMs = start ? Date.now() - start : undefined;
    this.startedAt.delete(runId);
    if (this.emitter && this.reasoningPhaseOpen) {
      this.emitter.emit("event", { type: "reasoning_phase_finished", phase: "final" });
      this.reasoningPhaseOpen = false;
      logger.debug("agent", "reasoning_phase_finished", { session: this.sessionId, runId, error: true, phase: "final" }, this.sessionId);
    }
    logger.error(
      "llm",
      "call_error",
      {
        session: this.sessionId,
        runId,
        latencyMs,
        error: err instanceof Error ? err.message : String(err),
      },
      this.sessionId,
    );
  }

  handleChainStart(
    chain: any,
    inputs: any,
    runId: string,
    _runType?: string,
    _tags?: string[],
    _metadata?: any,
    runName?: string,
    parentRunId?: string,
  ): void {
    this.startedAt.set(runId, Date.now());
    const name =
      runName ||
      (Array.isArray(chain?.id) ? chain.id.at(-1) : undefined) ||
      chain?.name;
    logger.debug(
      "chain",
      "start",
      {
        session: this.sessionId,
        runId,
        parentRunId,
        name,
        inputSize: estSize(inputs),
      },
      this.sessionId,
    );
  }

  handleChainEnd(outputs: any, runId: string, parentRunId?: string): void {
    const start = this.startedAt.get(runId);
    const latencyMs = start ? Date.now() - start : undefined;
    this.startedAt.delete(runId);
    logger.debug(
      "chain",
      "end",
      {
        session: this.sessionId,
        runId,
        parentRunId,
        latencyMs,
        outputSize: estSize(outputs),
      },
      this.sessionId,
    );
  }

  handleChainError(err: any, runId: string, parentRunId?: string): void {
    const start = this.startedAt.get(runId);
    const latencyMs = start ? Date.now() - start : undefined;
    this.startedAt.delete(runId);
    logger.error(
      "chain",
      "error",
      {
        session: this.sessionId,
        runId,
        parentRunId,
        latencyMs,
        error: err instanceof Error ? err.message : String(err),
      },
      this.sessionId,
    );
  }

  handleToolStart(
    tool: any,
    input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: any,
    runName?: string,
    toolCallId?: string,
  ): void {
    this.startedAt.set(runId, Date.now());
    const name =
      runName || tool?.name || (Array.isArray(tool?.id) ? tool.id.at(-1) : undefined);
    const inputPreview =
      typeof input === "string" ? input.slice(0, 500) : preview(input);
    logger.info(
      "tool",
      "start",
      {
        session: this.sessionId,
        runId,
        parentRunId,
        toolCallId,
        name,
        inputPreview,
      },
      this.sessionId,
    );
  }

  handleToolEnd(output: any, runId: string, parentRunId?: string): void {
    const start = this.startedAt.get(runId);
    const latencyMs = start ? Date.now() - start : undefined;
    this.startedAt.delete(runId);
    const s = typeof output === "string" ? output : safeStringify(output);
    logger.info(
      "tool",
      "end",
      {
        session: this.sessionId,
        runId,
        parentRunId,
        latencyMs,
        outputLen: s?.length ?? 0,
      },
      this.sessionId,
    );
  }

  handleToolError(err: any, runId: string, parentRunId?: string): void {
    const start = this.startedAt.get(runId);
    const latencyMs = start ? Date.now() - start : undefined;
    this.startedAt.delete(runId);
    logger.error(
      "tool",
      "error",
      {
        session: this.sessionId,
        runId,
        parentRunId,
        latencyMs,
        error: err instanceof Error ? err.message : String(err),
      },
      this.sessionId,
    );
  }
}
