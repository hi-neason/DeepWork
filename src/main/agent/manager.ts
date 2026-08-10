import { EventEmitter } from "node:events";
import { RemoveMessage, HumanMessage } from "@langchain/core/messages";
import i18n from "../i18n";

import { classifyModelError } from "./model";
import { listSessionArtifacts } from "./artifacts";
import { SessionRuntime } from "./sessionRuntime";
import { TurnRuntime } from "./turnRuntime";
import { projectHistory } from "./history";
import { setThreadRoot } from "./sanitize";
import { registerTurnEmitter, unregisterTurnEmitter } from "./turnEvents";
import { EventProjector } from "./eventProjector";
import { PostTurnService } from "./postTurn";
import { TitleGenerationService } from "./titleGeneration";
import { AgentRuntimeService } from "./runtime";
import { approvals } from "../security/approvals";
import { logger } from "../log/logger";
import { getSession } from "../storage/sessions";
import type {
  ArtifactFile,
  Attachment,
  DeepWorkEvent,
  HistoryItem,
  PermissionMode,
  TodoItem,
  TurnStatus,
} from "../../shared/types";
import { loadSettings } from "../storage/settings";
import { addMemory, searchMemories } from "../storage/memories";
import { touchSession } from "../storage/sessions";
import { sessionRootDir, sessionArtifactsDir, hasPickedWorkspace } from "../config/paths";

/** Hard upper bound for a model/tool stream, independent of UI liveness. */
export const TURN_MAX_DURATION_MS = 15 * 60 * 1000;

/** Pull concatenated text from a message content that may be a string or an array of blocks. */
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

/** Pull reasoning/thinking text from content blocks or additional_kwargs. */
function extractReasoning(
  content: unknown,
  additional: Record<string, unknown> | undefined,
): string {
  if (typeof additional?.reasoning === "string") return additional.reasoning;
  // Volcengine Ark / DeepSeek / Qwen-thinking and other OpenAI-compatible
  // gateways expose thinking text under `reasoning_content` (a per-chunk
  // delta in streaming mode). @langchain/openai leaves it raw in
  // additional_kwargs, so we read it explicitly here.
  if (typeof additional?.reasoning_content === "string") return additional.reasoning_content;
  if (Array.isArray(content)) {
    let out = "";
    for (const block of content) {
      if (
        block &&
        (block.type === "thinking" || block.type === "reasoning") &&
        typeof block.thinking === "string"
      ) {
        out += block.thinking;
      }
    }
    return out;
  }
  return "";
}

/** Flatten any message content (string | block[] | object) into plain text, truncated. */
function previewText(content: unknown, max = 800): string {
  // Safe property reader: avoids `as any` while tolerating the various block
  // shapes (text / thinking / image_url) produced by the model SDKs.
  const strProp = (o: unknown, key: string): string | undefined => {
    if (o && typeof o === "object") {
      const v = (o as Record<string, unknown>)[key];
      if (typeof v === "string") return v;
    }
    return undefined;
  };
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object") {
          return strProp(b, "text") ?? strProp(b, "thinking") ?? JSON.stringify(b);
        }
        return String(b);
      })
      .join("");
  } else if (content && typeof content === "object") {
    text = strProp(content, "text") ?? JSON.stringify(content);
  } else {
    text = String(content ?? "");
  }
  return text.length > max ? text.slice(0, max) + `…(+${text.length - max})` : text;
}

/** Turn a user message + attachments into a LangChain multi-block content array. */
function buildUserContent(
  text: string,
  attachments: Attachment[] = [],
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const att of attachments) {
    if (att.kind === "image" && att.dataUrl) {
      blocks.push({ type: "image_url", image_url: { url: att.dataUrl } });
    } else if (att.kind === "pdf" && att.dataUrl) {
      // Anthropic-native PDF document block (works with Anthropic-compatible gateways).
      const base64 = att.dataUrl.includes(",")
        ? att.dataUrl.slice(att.dataUrl.indexOf(",") + 1)
        : att.dataUrl;
      blocks.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: base64,
        },
      });
    } else if (att.text) {
      blocks.push({
        type: "text",
        text: `Attached file: ${att.name}\n\n${att.text}`,
      });
    } else {
      blocks.push({ type: "text", text: `Attached file: ${att.name} (${att.mimeType})` });
    }
  }
  if (text.trim()) blocks.push({ type: "text", text });
  return blocks;
}

/**
 * Builds and owns the deepagents agent. Rebuilt when settings (model / MCP /
 * workspace) change. Runs a single turn at a time per session.
 */
export class AgentManager {
  /** Ephemeral per-session workspace, model, permission, and grant state. */
  private runtime = new SessionRuntime();
  /** DeepAgent graph construction, MCP, middleware, model-agent caches. */
  private agentRuntime = new AgentRuntimeService(
    this.runtime,
    (model) => this.titles.setDefaultModel(model),
    SYSTEM_PROMPT,
  );
  /** Active turn identity, cancellation, and lifecycle ownership. */
  private turns = new TurnRuntime();
  /** Best-effort post-turn memory and timeline capture. */
  private postTurn = new PostTurnService();
  /** Background title generation and renderer title-push updates. */
  private titles = new TitleGenerationService();
  /** Wire up the renderer sender so title updates can be pushed independently. */
  setSender(send: (channel: string, ...args: unknown[]) => void): void {
    this.titles.setSender(send);
  }

  /** Resolve the workspace for a session (session override or settings default). */
  resolveWorkspace(sessionId: string, fallback: string): string {
    return this.runtime.getWorkspace(sessionId) || fallback;
  }

  async ensureAgent(): Promise<void> {
    return this.agentRuntime.ensureAgent();
  }

  /** Key under which an agent for a given model config is cached. */
  private modelKey(cfg: { provider: string; model: string }): string {
    return this.agentRuntime.modelKey(cfg);
  }

  /**
   * Return a compiled agent for the given model id. The default provider is
   * used unless the id looks like "provider:model". Agents are cached so
   * switching models in the UI is cheap.
   */
  async getAgentForModel(modelId?: string) {
    return this.agentRuntime.getAgentForModel(modelId);
  }

  async rebuild(): Promise<void> {
    this.titles.clearCaches();
    await this.agentRuntime.rebuild();
  }

  /** Per-server MCP connection outcomes from the most recent agent build. */
  getMcpStatus() {
    return this.agentRuntime.getMcpStatus();
  }

  /**
   * Lightweight reload after a skill change: rebuild only the skills
   * middleware, swap it into the shared middleware array, and recompile
   * agents. Does NOT close MCP connections or clear always-allow state.
   * Never throws — errors are logged and the app stays alive.
   */
  async rebuildSkills(): Promise<void> {
    await this.agentRuntime.rebuildSkills();
  }

  /** Request cancellation of an in-flight turn for a session. */
  cancel(sessionId: string): void {
    logger.info("agent", "turn_cancel", { session: sessionId }, sessionId);
    this.turns.cancel(sessionId);
    // Only reject approvals belonging to this session — cancelling A must not
    // deny session B's pending tool approvals (H-A2 fix).
    approvals.rejectAll(sessionId);
  }

  /** Run a turn with no interactive user (e.g. a scheduled automation). */
  async *runUnattendedTurn(
    sessionId: string,
    instructions: string,
    modelId?: string,
    mode?: PermissionMode,
  ): AsyncGenerator<DeepWorkEvent> {
    this.runtime.setUnattended(sessionId, true);
    // Make sure the session's workspace context is registered even without an
    // interactive chat:history call.
    if (!this.runtime.hasWorkspace(sessionId)) {
      const s = getSession(sessionId);
      if (s) {
        const picked = hasPickedWorkspace(s.workspaceDir);
        const root = sessionRootDir(s.id, s.workspaceDir);
        // Deliverables always land in the per-session output drawer so each
        // chat's artifacts stay isolated — inside the project for picked
        // folders, and under ~/DeepWork/workspace/.deepwork for the default
        // workspace. (Using the shared default workspace as outputDir would
        // make every session show the same artifacts.)
        const outputDir = sessionArtifactsDir(s.id, s.workspaceDir!);
        this.setSessionRoot(sessionId, root, outputDir, picked);
      }
    }
    try {
      yield* this.runTurn(sessionId, instructions, undefined, undefined, modelId, mode);
    } finally {
      this.runtime.setUnattended(sessionId, false);
    }
  }

  /**
   * Register a session's working directory (cwd + fs-sandbox root). Loaded
   * when the session is selected. For picked folders, outputDir points at the
   * per-session artifacts drawer and isProject=true so the system prompt
   * names both the project root and where deliverables must land.
   */
  setSessionRoot(
    sessionId: string,
    rootDir?: string,
    outputDir?: string,
    isProject?: boolean,
  ): void {
    if (rootDir) {
      this.runtime.setWorkspace(sessionId, rootDir, isProject);
      setThreadRoot(sessionId, rootDir, outputDir, isProject);
    } else {
      this.runtime.setWorkspace(sessionId);
      setThreadRoot(sessionId, "");
    }
  }

  /** Register a session's model override (loaded when the session is selected). */
  setSessionModel(sessionId: string, modelId?: string): void {
    this.runtime.setModel(sessionId, modelId);
  }

  /**
   * Register (or clear) a session's permission-mode override. Passing no mode
   * clears it so the session falls back to the global setting — without this
   * a session that ever ran in `auto` stayed in `auto` forever, silently
   * keeping the approval gate open after the user switched back (H-A3).
   */
  setSessionMode(sessionId: string, mode?: PermissionMode): void {
    this.runtime.setMode(sessionId, mode);
  }

  /** Drop all per-session runtime state (called when a session is deleted). */
  forgetSession(sessionId: string): void {
    // Abort any in-flight turn first, then clear its bookkeeping.
    this.cancel(sessionId);
    this.turns.forget(sessionId);
    this.runtime.forget(sessionId);
    this.titles.forgetSession(sessionId);
  }

  /** Current model id used by a session (override or default), for the UI. */
  modelForSession(sessionId: string): string {
    return this.runtime.getModel(sessionId) ?? this.modelKey(loadSettings().model);
  }

  /** Snapshot used by the renderer after session switches or reconnects. */
  getTurnStatus(sessionId: string): TurnStatus {
    return this.turns.status(sessionId);
  }

  /** Run a turn from a new user message. */
  async *runTurn(
    sessionId: string,
    userText: string,
    attachments?: Attachment[],
    workspaceDir?: string,
    modelId?: string,
    mode?: PermissionMode,
  ): AsyncGenerator<DeepWorkEvent> {
    const content = buildUserContent(userText, attachments);
    const tTurn = Date.now();
    logger.info(
      "agent",
      "turn_start",
      {
        session: sessionId,
        model: modelId ?? this.modelForSession(sessionId),
        workspace: workspaceDir ?? this.runtime.getWorkspace(sessionId),
        inputLen: userText?.length ?? 0,
      },
      sessionId,
    );
    if (workspaceDir) {
      // Register full workspace context (cwd + output drawer) for the prompt.
      const s = getSession(sessionId);
      const picked = hasPickedWorkspace(s?.workspaceDir);
      this.runtime.setWorkspace(sessionId, workspaceDir, picked);
      const outputDir = picked
        ? sessionArtifactsDir(sessionId, s!.workspaceDir!)
        : workspaceDir;
      setThreadRoot(sessionId, workspaceDir, outputDir, picked);
    }
    if (modelId) this.runtime.setModel(sessionId, modelId);
    // Clearing on an absent mode is deliberate — see setSessionMode (H-A3).
    this.setSessionMode(sessionId, mode);
    const ws = this.runtime.getWorkspace(sessionId);
    const result = yield* this.runStream(
      sessionId,
      {
        messages: [{ role: "user", content }],
        ...(ws ? { workspaceDir: ws } : {}),
      },
      modelId,
      userText,
    );
    if (result.failed) return;
    if (result.aborted) {
      logger.info("agent", "turn_aborted", { session: sessionId }, sessionId);
      yield { type: "turn_aborted" };
      return;
    }
    // Surface per-turn telemetry to the renderer (model / tokens / latency).
    yield {
      type: "turn_stats",
      model: result.model,
      inputTokens: result.tokens.inputTokens,
      outputTokens: result.tokens.outputTokens,
      totalTokens: result.tokens.totalTokens,
      llmCalls: result.llmCalls,
      durationMs: result.durationMs,
      ...(result.firstTokenMs !== undefined ? { firstTokenMs: result.firstTokenMs } : {}),
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
    };
    this.postTurn.afterSuccessfulTurn(sessionId, userText, result.replyText, ws);
    // Unlock the input immediately after a successful turn finishes.
    yield { type: "turn_completed" };
    logger.info(
      "agent",
      "turn_completed",
      {
        session: sessionId,
        durationMs: Date.now() - tTurn,
        replyLen: result.replyText.length,
        tokens: result.tokens,
        llmCalls: result.llmCalls,
      },
      sessionId,
    );
    // Surface any artifacts produced in the workspace during this session.
    const artifacts = this.listArtifacts(sessionId);
    if (artifacts.length) yield { type: "artifacts_updated", artifacts };
    // The title is generated in parallel and pushed independently of the turn
    // event stream — nothing to do here.
  }

  /**
   * Core streaming loop. Invokes the agent with the given input, normalizes
   * token/tool events into DeepWorkEvents, and resolves with the assistant's
   * aggregated reply text.
   */
  private async *runStream(
    sessionId: string,
    input: Record<string, unknown>,
    modelId?: string,
    userText?: string,
  ): AsyncGenerator<
    DeepWorkEvent,
    {
      replyText: string;
      aborted: boolean;
      failed: boolean;
      tokens: { inputTokens: number; outputTokens: number; totalTokens: number };
      llmCalls: number;
      durationMs: number;
      firstTokenMs?: number;
      model: string;
      finishReason?: string;
    },
    void
  > {
    try {
      await this.ensureAgent();
    } catch (e) {
      logger.error(
        "agent",
        "ensure_agent_failed",
        { session: sessionId, error: e instanceof Error ? e.message : e },
        sessionId,
      );
      throw e;
    }
    const agent = await this.getAgentForModel(
      modelId ?? this.runtime.getModel(sessionId),
    );
    logger.debug(
      "agent",
      "model_resolved",
      { session: sessionId, model: modelId ?? this.runtime.getModel(sessionId) },
      sessionId,
    );

    const emitter = new EventEmitter();
    // This turn owns the session's live event stream until it finishes. If a
    // previous turn on the same session is still draining, its emitter is
    // displaced but its aborter (keyed by turnId) is left intact.
    const { turnId, controller: ac } = this.turns.start(sessionId);
    registerTurnEmitter(turnId, sessionId, emitter);

    // Generate the session title on its own independent Promise, fully
    // detached from the turn's event stream. When it finishes it pushes a
    // session_renamed event directly via the injected sender, so the UI
    // refreshes regardless of whether the turn is still running.
    // Defer with setImmediate so any synchronous model setup does not compete
    // with the agent's first token delivery.
    if (userText) {
      setImmediate(() => {
        void this.titles.maybeGenerateTitle(sessionId, userText, modelId, [logHandler]);
      });
    }

    const queue: DeepWorkEvent[] = [];
    let waiter: ((() => void) | null) = null;
    let reasoningChars = 0;
    let reasoningText = "";
    const tStreamStart = Date.now();
    let firstTokenMs: number | undefined;
    const emitTurnState = (): void => {
      queue.push({ type: "turn_state", status: this.turns.status(sessionId) });
    };
    emitTurnState();
    const scanArtifacts = (): void => {
      try {
        const files = this.listArtifacts(sessionId);
        queue.push({ type: "artifacts_updated", artifacts: files });
      } catch {
        // ignore scan errors
      }
    };
    const onEvent = (e: DeepWorkEvent) => {
      queue.push(e);
      if (e.type === "approval_requested") {
        if (this.turns.setState(sessionId, turnId, "waiting_approval")) emitTurnState();
      } else if (e.type === "tool_call_started" || e.type === "tool_call_finished") {
        if (this.turns.setState(sessionId, turnId, "running")) emitTurnState();
      }
      if (e.type === "reasoning_delta") {
        reasoningChars += e.text?.length ?? 0;
      } else if (e.type === "tool_call_finished") {
        // Refresh the artifact list after every tool call (write/edit/exec/…).
        // The file write is complete by the time tool_call_finished fires.
        // (Tool start/end/error are logged from the LangChain callback layer
        // in EventProjector, which also carries runId linkage.)
        scanArtifacts();
      }
      waiter?.();
    };
    emitter.on("event", onEvent);

    const logHandler = new EventProjector(sessionId, emitter);
    const config = {
      configurable: { thread_id: sessionId },
      recursionLimit: 50,
      signal: ac.signal,
      callbacks: [logHandler],
    };

    let replyText = "";
    let aborted = false;
    let lastResponseMeta: Record<string, unknown> | undefined;
    let lastUsageMeta: Record<string, unknown> | undefined;
    // Probe: capture what the provider actually returns so we can see why
    // reasoning isn't surfaced (wrong field name / dropped by the SDK).
    let probeSeenReasoning = false;
    const probeReasoningKeys = new Set<string>();
    let lastAdditionalKeys: string[] = [];
    let lastContentTypes: string[] = [];
    let settled = false;
    let failed = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (this.turns.setState(sessionId, turnId, "cancelling")) emitTurnState();
      ac.abort();
      waiter?.();
    }, TURN_MAX_DURATION_MS);
    const consumed = (async () => {
      const t0 = Date.now();
      let firstToken = false;
      logger.info(
        "agent",
        "stream_start",
        { session: sessionId, model: modelId ?? this.runtime.getModel(sessionId) },
        sessionId,
      );
      // Structured view of what we send to the model: per-message role, size and
      // a short text preview (DEBUG — noisy, for deep troubleshooting).
      const inMessages = Array.isArray((input as any)?.messages)
        ? (input as any).messages
        : [];
      logger.debug(
        "llm",
        "call_input",
        {
          session: sessionId,
          model: modelId ?? this.runtime.getModel(sessionId),
          count: inMessages.length,
          messages: inMessages.map((m: any) => {
            const c = m?.content;
            const len =
              c == null
                ? 0
                : typeof c === "string"
                  ? c.length
                  : JSON.stringify(c).length;
            return { role: m?.getType?.() ?? m?.role ?? "?", len, preview: previewText(c, 200) };
          }),
        },
        sessionId,
      );
      const stream = await agent.stream(input, {
        streamMode: "messages",
        subgraphs: false,
        ...config,
      });
      for await (const chunk of stream as AsyncIterable<[any, any]>) {
        const [msg] = chunk;
        if (!msg) continue;
        const type = msg.getType?.() ?? msg._getType?.();
        if (type !== "ai" && type !== "AIMessageChunk") continue;
        const rm = msg.response_metadata;
        if (rm && typeof rm === "object") lastResponseMeta = rm;
        const um = msg.usage_metadata;
        if (um && typeof um === "object") lastUsageMeta = um;
        // Probe the shape of each AI chunk (DEBUG only, used to diagnose why
        // reasoning may be missing — wrong field name or dropped by the SDK).
        const ak = (msg.additional_kwargs || {}) as Record<string, unknown>;
        lastAdditionalKeys = Object.keys(ak);
        lastContentTypes = Array.isArray(msg.content)
          ? msg.content.map((b: any) => b?.type ?? typeof b)
          : ["string"];
        if (ak.reasoning != null) { probeSeenReasoning = true; probeReasoningKeys.add("reasoning"); }
        if ((ak as any).reasoning_content != null) { probeSeenReasoning = true; probeReasoningKeys.add("reasoning_content"); }
        const reasoning = extractReasoning(msg.content, msg.additional_kwargs);
        if (reasoning) {
          emitter.emit("event", { type: "reasoning_delta", text: reasoning });
          if (reasoningText.length < 1600) reasoningText += reasoning;
        }
        const text = extractText(msg.content);
        if (text) {
          replyText += text;
          emitter.emit("event", { type: "message_delta", text });
          if (!firstToken) {
            firstToken = true;
            firstTokenMs = Date.now() - t0;
            logger.info(
              "agent",
              "first_token",
              { session: sessionId, latencyMs: firstTokenMs },
              sessionId,
            );
          }
        }
      }
      logger.debug(
        "agent",
        "stream_end",
        {
          session: sessionId,
          finishReason: (lastResponseMeta?.finish_reason as string) || undefined,
          responseModel:
            (lastResponseMeta?.model as string) ||
            (lastUsageMeta?.model as string) ||
            undefined,
          usageMetadata: lastUsageMeta ?? undefined,
          reasoningChars,
          reasoningPreview: reasoningText ? previewText(reasoningText, 1200) : undefined,
          probe: {
            additionalKeys: lastAdditionalKeys,
            contentTypes: lastContentTypes,
            reasoningFields: [...probeReasoningKeys],
            hasReasoning: probeSeenReasoning,
          },
        },
        sessionId,
      );
    })();

    try {
      // Race-free pump: arm the waiter before deciding to wait.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        let resolveWait: (v: false) => void = () => {};
        waiter = () => resolveWait(false);
        const done = await Promise.race([
          consumed.then(() => true),
          new Promise<false>((res) => {
            resolveWait = res;
          }),
        ]);
        waiter = null;
        if (done && queue.length === 0) break;
      }
      await consumed;
      settled = true;
      touchSession(sessionId);
    } catch (err) {
      if (ac.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        if (timedOut) {
          failed = true;
          yield { type: "turn_error", message: i18n.t("errors.turnMaxDuration") };
        } else {
          aborted = true;
        }
      } else {
        failed = true;
        logger.error(
          "agent",
          "turn_error",
          {
            session: sessionId,
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          sessionId,
        );
        const kind = classifyModelError(err);
        yield { type: "turn_error", message: i18n.t(`errors.model.${kind}`) };
      }
    } finally {
      // H-A4: if the consumer abandoned the generator before `consumed` settled
      // (e.g. the IPC response was destroyed, or the caller broke out of the
      // for-await loop), abort the underlying LLM/tool stream instead of letting
      // it keep running unattended.
      if (!settled) ac.abort();
      clearTimeout(timeout);
      this.turns.finish(
        sessionId,
        turnId,
        settled ? "completed" : aborted ? "cancelled" : "error",
      );
      emitter.removeListener("event", onEvent);
      unregisterTurnEmitter(turnId, sessionId);
    }
    return {
      replyText,
      aborted,
      failed,
      tokens: {
        inputTokens: logHandler.totals.inputTokens,
        outputTokens: logHandler.totals.outputTokens,
        totalTokens: logHandler.totals.inputTokens + logHandler.totals.outputTokens,
      },
      llmCalls: logHandler.totals.calls,
      durationMs: Date.now() - tStreamStart,
      firstTokenMs,
      model: modelId ?? this.runtime.getModel(sessionId) ?? "unknown",
      finishReason: (lastResponseMeta?.finish_reason as string) || undefined,
    };
  }

  respondApproval(toolCallId: string, decision: "allow" | "deny" | "always_allow"): void {
    approvals.respond(toolCallId, decision);
  }

  /**
   * Regenerate: drop the last human message and everything after it from the
   * checkpointer, then re-send that human message for a fresh response.
   */
  async *regenerate(sessionId: string): AsyncGenerator<DeepWorkEvent> {
    await this.ensureAgent();
    const agent = await this.getAgentForModel(this.runtime.getModel(sessionId));
    const config = { configurable: { thread_id: sessionId } };
    const state: any = await (agent as any).getState(config);
    const messages: any[] = state?.values?.messages ?? [];
    let lastHuman = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const t = messages[i]._getType?.() ?? messages[i].getType?.();
      if (t === "human") {
        lastHuman = i;
        break;
      }
    }
    if (lastHuman < 0) {
      yield { type: "turn_error", message: i18n.t("errors.nothingToRegenerate") };
      return;
    }
    const lastHumanMsg = messages[lastHuman];
    const humanContent = lastHumanMsg.content;
    const toRemove = messages
      .slice(lastHuman)
      .filter((m) => m?.id)
      .map((m) => new RemoveMessage({ id: m.id }));
    if (toRemove.length > 0) {
      await (agent as any).updateState(config, { messages: toRemove });
    }
    const result = yield* this.runStream(sessionId, {
      messages: [new HumanMessage(humanContent)],
    });
    yield {
      type: "turn_stats",
      model: result.model,
      inputTokens: result.tokens.inputTokens,
      outputTokens: result.tokens.outputTokens,
      totalTokens: result.tokens.totalTokens,
      llmCalls: result.llmCalls,
      durationMs: result.durationMs,
      ...(result.firstTokenMs !== undefined ? { firstTokenMs: result.firstTokenMs } : {}),
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
    };
    yield { type: "turn_completed" };
    if (result.aborted) yield { type: "turn_aborted" };
  }

  /** List all files in the session's output folder (the artifacts panel). */
  listArtifacts(sessionId: string): ArtifactFile[] {
    return listSessionArtifacts(sessionId);
  }

  /**
   * Reconstruct a coarse chat timeline from the persisted checkpointer state
   * for a thread, so switching sessions shows prior messages. Tool call/result
   * pairs are collapsed into a single tool record. Also returns the latest
   * todo plan (from the most recent write_todos call) so the Progress panel
   * survives reloads/session switches.
   */
  async getHistory(
    sessionId: string,
  ): Promise<{ timeline: HistoryItem[]; todos: TodoItem[] }> {
    await this.ensureAgent();
    const agent = await this.getAgentForModel(this.runtime.getModel(sessionId));
    const config = { configurable: { thread_id: sessionId } };
    const state: any = await (agent as any).getState(config);
    const messages: any[] = state?.values?.messages ?? [];
    return projectHistory(messages, (message) => extractReasoning(message.content, message.additional_kwargs));
  }
}

const SYSTEM_PROMPT = `You are DeepWork, a local-first personal desktop AI assistant.

You can accomplish tasks on this computer using tools:
- Read, write, edit and search files; run shell commands.
- See the screen with "screenshot", then operate the GUI with mouse/keyboard tools.
  GUI tools are a fallback — prefer file/shell/MCP tools when available.
- Search the public web with "web_search" and read pages with "web_fetch".
- Remember durable facts about the user with "remember" / "forget" / "list_memories".
- Track multi-step work with "write_todos" so the user can see progress.
- Use MCP plugin tools for connected services.

Before any mouse/keyboard action, always call screenshot first to see the current
screen and use the coordinates it reports. Coordinates are absolute pixels from
the top-left (0,0). Be precise and conservative — do not click or type unless
you are sure what has focus.

When you create deliverables (documents, code, reports, data files), save them
into the workspace and mention the file paths in your final reply so the user
can open them from the artifacts panel.

WORKFLOW (always follow):
1. At the very start of EVERY user request, call "write_todos" with an ordered
   plan. Even simple tasks get at least one todo (e.g. ["Create the HTML file",
   "Report the result"]). Mark the first item "in_progress".
2. Execute the plan step by step, updating todo statuses as you go
   (in_progress when starting, completed when done).
3. When all steps are done, give a concise summary in the same language as the
   user's request. The summary must explain what was done and what the outcome
   was. Never end the response with bare action names or step markers (e.g.
   "create", "search", "run", "plan") — those are internal, not user-facing.

When a task requires a consequential action (writing files, running commands,
network actions, any GUI action), you will be asked to approve it through the
user. Report results concisely.`;

export const agentManager = new AgentManager();
