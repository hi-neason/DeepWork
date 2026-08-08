import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import {
  createDeepAgent,
  LocalShellBackend,
  StateBackend,
  FilesystemBackend,
  createSummarizationMiddleware,
  createSkillsMiddleware,
} from "deepagents";
import { StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { RemoveMessage, HumanMessage } from "@langchain/core/messages";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import i18n from "../i18n";
import type { DeepAgent } from "deepagents";
import type { StructuredToolInterface } from "@langchain/core/tools";

import { createChatModel } from "./model";
import { createApprovalMiddleware } from "./middleware";
import { createSanitizeMiddleware, setThreadRoot } from "./sanitize";
import { createContextMiddleware } from "./context";
import { registerTurnEmitter, unregisterTurnEmitter } from "./turnEvents";
import { approvals } from "../security/approvals";
import { logger } from "../log/logger";
import { McpManager } from "../mcp/manager";
import { getSession, renameSession } from "../storage/sessions";
import type {
  ArtifactFile,
  Attachment,
  DeepWorkEvent,
  HistoryItem,
  TodoItem,
} from "../../shared/types";
import { screenshotTool } from "../tools/gui";
import {
  mouseMoveTool,
  mouseClickTool,
  keyboardTypeTool,
  keyboardPressTool,
} from "../tools/control";
import { annotateRisk } from "../tools/registry";
import { loadSettings } from "../storage/settings";
import { addMemory, searchMemories } from "../storage/memories";
import { touchSession } from "../storage/sessions";
import { WEB_TOOLS } from "../tools/web";
import { createTodosTool } from "../tools/todos";
import { createMemoryTools } from "../tools/memory";
import { appendToRecent, readRawMemory } from "../storage/user-memory";
import { appendTimelineEntry } from "../storage/timeline-memory";
import { skillsSourcePath } from "../skills/store";
import { APP_DATA_DIR, DEFAULT_WORKSPACE_DIR, sessionRootDir, sessionArtifactsDir, hasPickedWorkspace } from "../config/paths";

type StateSchemaT = InstanceType<typeof StateSchema>;

const GUI_TOOLS = [
  screenshotTool.tool,
  mouseMoveTool.tool,
  mouseClickTool.tool,
  keyboardTypeTool.tool,
  keyboardPressTool.tool,
];

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
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object") {
          if (typeof (b as any).text === "string") return (b as any).text;
          if (typeof (b as any).thinking === "string") return (b as any).thinking;
          return JSON.stringify(b);
        }
        return String(b);
      })
      .join("");
  } else if (content && typeof content === "object") {
    if (typeof (content as any).text === "string") text = (content as any).text;
    else text = JSON.stringify(content);
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
  private mcp = new McpManager();
  private checkpointer: SqliteSaver | null = null;
  private alwaysAllow = new Set<string>();
  private titledSessions = new Set<string>();
  private building: Promise<void> | null = null;
  private chatModel: ReturnType<typeof createChatModel> | null = null;
  /** Sender for pushing title updates outside the turn's event stream. */
  private send: ((channel: string, ...args: unknown[]) => void) | null = null;
  /** Models reused for title generation, keyed by provider:model. */
  private titleModels = new Map<string, ReturnType<typeof createChatModel>>();
  /** Cached compiled agents keyed by a model id (one default agent + per overrides). */
  private agents = new Map<string, DeepAgent>();
  /** Shared tools/middleware, initialized once and reused across model agents. */
  private shared: {
    tools: StructuredToolInterface[];
    middleware: unknown[];
    stateSchema: StateSchemaT;
    defaultWorkspace: string;
  } | null = null;
  /** The active skills middleware instance (rebuilt on skill changes). */
  private skillsMiddleware: ReturnType<typeof createSkillsMiddleware> | null = null;
  private aborters = new Map<string, AbortController>();
  /** First-run timestamp per session — used to bound artifact scanning. */
  private sessionStartedAt = new Map<string, number>();
  /** Per-session workspace root. */
  private sessionWorkspace = new Map<string, string>();
  /** Cache of one LocalShellBackend per workspace root. */
  private backends = new Map<string, LocalShellBackend>();
  /** Sessions running without an interactive user (scheduled automations). */
  private unattended = new Set<string>();
  /** Per-session model override. */
  private sessionModel = new Map<string, string>();

  /** Wire up the renderer sender so title updates can be pushed independently. */
  setSender(send: (channel: string, ...args: unknown[]) => void): void {
    this.send = send;
  }

  private backendFor(root: string): LocalShellBackend {
    const key = root || DEFAULT_WORKSPACE_DIR;
    let b = this.backends.get(key);
    if (!b) {
      // virtualMode sandboxes every path under rootDir: absolute paths
      // (e.g. "/tmp/x.html", "/Users/...") are rewritten inside the
      // session folder, and ".." traversal is rejected. This guarantees
      // all produced files live in <workspace>/<sessionId>/.
      b = new LocalShellBackend({ rootDir: key, virtualMode: true });
      this.backends.set(key, b);
    }
    return b;
  }

  /** Resolve the workspace for a session (session override or settings default). */
  resolveWorkspace(sessionId: string, fallback: string): string {
    return this.sessionWorkspace.get(sessionId) || fallback;
  }

  /** The default (settings) agent. Per-model overrides live in `agents`. */
  private get agent(): DeepAgent | null {
    if (!this.shared) return null;
    const settings = loadSettings();
    return this.agents.get(this.modelKey(settings.model)) ?? null;
  }

  async ensureAgent(): Promise<void> {
    if (this.shared) return;
    if (this.building) return this.building;
    this.building = this._build();
    try {
      await this.building;
    } finally {
      this.building = null;
    }
  }

  private async _build(): Promise<void> {
    const settings = loadSettings();
    const model = createChatModel(settings.model);
    this.chatModel = model;

    const dbPath = path.join(APP_DATA_DIR, "checkpoints.db");
    this.checkpointer = SqliteSaver.fromConnString(dbPath);

    // MCP build must never block agent startup or chat-history loading.
    // A bad server config degrades to "no MCP tools" rather than a thrown error.
    let mcpTools: StructuredToolInterface[] = [];
    try {
      mcpTools = await this.mcp.buildTools(settings.mcpServers);
    } catch (err) {
      logger.error("agent", "mcp_build_failed", {
        error: err instanceof Error ? err.message : err,
      });
      mcpTools = [];
    }

    // Default workspace lives under ~/DeepWork/workspace, but a session may
    // override it with any folder chosen in the new-task picker.
    const defaultWorkspace = settings.model.workspaceDir || DEFAULT_WORKSPACE_DIR;

    // deepagents built-in fs tools: write/edit/execute are write/exec risk.
    annotateRisk("write_file", "write");
    annotateRisk("edit_file", "write");
    annotateRisk("execute", "exec");
    annotateRisk("web_search", "read");
    annotateRisk("web_fetch", "read");
    annotateRisk("remember", "read");
    annotateRisk("forget", "read");
    annotateRisk("list_memories", "read");
    annotateRisk("write_todos", "read");

    const scopeKey = defaultWorkspace;
    const self = this;
    const approvalMiddleware = createApprovalMiddleware({
      getAlwaysAllow: () => this.alwaysAllow,
      onAlwaysAllow: (name) => this.alwaysAllow.add(name),
      getMode: () => loadSettings().permissionMode,
      isUnattended: (threadId) => this.unattended.has(threadId),
    });

    // Auto-compression uses the active request model.
    const summarization = createSummarizationMiddleware({
      model,
      backend: () => new StateBackend(),
      trigger: { type: "tokens", value: 120_000 },
      keep: { type: "messages", value: 20 },
      trimTokensToSummarize: 4000,
    });

    // Skills: user-global (~/DeepWork/skills). The middleware injects
    // skill names+descriptions into the system prompt and loads full
    // SKILL.md content on demand.
    this.skillsMiddleware = createSkillsMiddleware({
      backend: new FilesystemBackend({
        rootDir: skillsSourcePath().replace(/\/$/, ""),
        virtualMode: true,
      }),
      sources: ["/"],
    });

    const tools: StructuredToolInterface[] = [
      ...GUI_TOOLS,
      ...WEB_TOOLS,
      createTodosTool().tool,
      ...createMemoryTools(scopeKey),
      ...mcpTools,
    ];

    const stateSchema = new StateSchema({
      workspaceDir: z.string().optional().default(defaultWorkspace),
    });

    // Shared, model-independent tooling/middleware; reused for every model agent.
    this.shared = {
      tools,
      middleware: [
        createSanitizeMiddleware(),
        summarization,
        this.skillsMiddleware!,
        createContextMiddleware(),
        approvalMiddleware,
      ],
      stateSchema: stateSchema as unknown as StateSchemaT,
      defaultWorkspace,
    };
    this.agents.set(this.modelKey(settings.model), this.compileAgent(model));
  }

  /** Key under which an agent for a given model config is cached. */
  private modelKey(cfg: { provider: string; model: string }): string {
    return `${cfg.provider}:${cfg.model}`;
  }

  /**
   * Return a compiled agent for the given model id. The default provider is
   * used unless the id looks like "provider:model". Agents are cached so
   * switching models in the UI is cheap.
   */
  async getAgentForModel(modelId?: string): Promise<DeepAgent> {
    await this.ensureAgent();
    if (!this.shared) throw new Error(i18n.t("errors.agentNotInitialized"));
    const settings = loadSettings();
    let provider = settings.model.provider;
    let modelName = settings.model.model;
    if (modelId) {
      if (modelId.includes(":")) {
        const [p, ...rest] = modelId.split(":");
        provider = p as typeof provider;
        modelName = rest.join(":");
      } else {
        modelName = modelId;
      }
    }
    const key = `${provider}:${modelName}`;
    const existing = this.agents.get(key);
    if (existing) return existing;
    const model = createChatModel({ ...settings.model, provider, model: modelName });
    const agent = this.compileAgent(model);
    this.agents.set(key, agent);
    return agent;
  }

  private compileAgent(model: ReturnType<typeof createChatModel>): DeepAgent {
    if (!this.shared) throw new Error(i18n.t("errors.agentNotInitialized"));
    const self = this;
    const { tools, middleware, stateSchema, defaultWorkspace } = this.shared;
    return createDeepAgent({
      model,
      tools: tools as StructuredToolInterface[],
      stateSchema: stateSchema as any,
      backend: (runtime: any) =>
        self.backendFor(runtime?.state?.workspaceDir || defaultWorkspace),
      checkpointer: this.checkpointer!,
      middleware: middleware as any,
      systemPrompt: SYSTEM_PROMPT,
    });
  }

  async rebuild(): Promise<void> {
    await this.mcp.close();
    this.agents.clear();
    this.shared = null;
    this.alwaysAllow.clear();
    await this.ensureAgent();
  }

  /**
   * Lightweight reload after a skill change: rebuild only the skills
   * middleware, swap it into the shared middleware array, and recompile
   * agents. Does NOT close MCP connections or clear always-allow state.
   * Never throws — errors are logged and the app stays alive.
   */
  async rebuildSkills(): Promise<void> {
    try {
      // If agent has never been built, do a full build.
      if (!this.shared) {
        await this.ensureAgent();
        return;
      }
      this.skillsMiddleware = createSkillsMiddleware({
        backend: new FilesystemBackend({
          rootDir: skillsSourcePath().replace(/\/$/, ""),
          virtualMode: true,
        }),
        sources: ["/"],
      });
      // Swap the skills middleware (index 2 in the middleware array).
      const mw = [...this.shared.middleware];
      mw[2] = this.skillsMiddleware;
      this.shared.middleware = mw;
      // Recompile the default agent so it picks up the new middleware.
      this.agents.clear();
      const settings = loadSettings();
      const model = createChatModel(settings.model);
      this.agents.set(this.modelKey(settings.model), this.compileAgent(model));
      logger.info("agent", "skills_reloaded");
    } catch (err) {
      logger.error("agent", "skills_reload_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Request cancellation of an in-flight turn for a session. */
  cancel(sessionId: string): void {
    logger.info("agent", "turn_cancel", { session: sessionId }, sessionId);
    const ac = this.aborters.get(sessionId);
    if (ac) ac.abort();
    approvals.rejectAll();
  }

  /** Run a turn with no interactive user (e.g. a scheduled automation). */
  async *runUnattendedTurn(
    sessionId: string,
    instructions: string,
  ): AsyncGenerator<DeepWorkEvent> {
    this.unattended.add(sessionId);
    // Make sure the session's workspace context is registered even without an
    // interactive chat:history call.
    if (!this.sessionWorkspace.has(sessionId)) {
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
      yield* this.runTurn(sessionId, instructions);
    } finally {
      this.unattended.delete(sessionId);
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
      this.sessionWorkspace.set(sessionId, rootDir);
      setThreadRoot(sessionId, rootDir, outputDir, isProject);
    } else {
      this.sessionWorkspace.delete(sessionId);
      setThreadRoot(sessionId, "");
    }
  }

  /** Register a session's model override (loaded when the session is selected). */
  setSessionModel(sessionId: string, modelId?: string): void {
    if (modelId) this.sessionModel.set(sessionId, modelId);
    else this.sessionModel.delete(sessionId);
  }

  /** Current model id used by a session (override or default), for the UI. */
  modelForSession(sessionId: string): string {
    return this.sessionModel.get(sessionId) ?? this.modelKey(loadSettings().model);
  }

  /** Run a turn from a new user message. */
  async *runTurn(
    sessionId: string,
    userText: string,
    attachments?: Attachment[],
    workspaceDir?: string,
    modelId?: string,
  ): AsyncGenerator<DeepWorkEvent> {
    const content = buildUserContent(userText, attachments);
    const tTurn = Date.now();
    logger.info(
      "agent",
      "turn_start",
      {
        session: sessionId,
        model: modelId ?? this.modelForSession(sessionId),
        workspace: workspaceDir ?? this.sessionWorkspace.get(sessionId),
        inputLen: userText?.length ?? 0,
      },
      sessionId,
    );
    if (!this.sessionStartedAt.has(sessionId)) {
      this.sessionStartedAt.set(sessionId, Date.now());
    }
    if (workspaceDir) {
      this.sessionWorkspace.set(sessionId, workspaceDir);
      // Register full workspace context (cwd + output drawer) for the prompt.
      const s = getSession(sessionId);
      const picked = hasPickedWorkspace(s?.workspaceDir);
      const outputDir = picked
        ? sessionArtifactsDir(sessionId, s!.workspaceDir!)
        : workspaceDir;
      setThreadRoot(sessionId, workspaceDir, outputDir, picked);
    }
    if (modelId) this.sessionModel.set(sessionId, modelId);
    const ws = this.sessionWorkspace.get(sessionId);
    const result = yield* this.runStream(
      sessionId,
      {
        messages: [{ role: "user", content }],
        ...(ws ? { workspaceDir: ws } : {}),
      },
      modelId,
      userText,
    );
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
    // Background memory extraction (non-blocking) when enabled.
    this.maybeExtractMemory(sessionId, userText, ws);
    // Background timeline capture (non-blocking, always on): distill this
    // turn's key points into today's timeline memory file.
    this.maybeAppendTimeline(sessionId, userText, result.replyText, ws);
    // Unlock the input immediately after the turn finishes.
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
    if (result.aborted) {
      logger.info("agent", "turn_aborted", { session: sessionId }, sessionId);
      yield { type: "turn_aborted" };
      return;
    }
    // Surface any artifacts produced in the workspace during this session.
    const artifacts = this.listArtifacts(sessionId);
    if (artifacts.length) yield { type: "artifacts_updated", artifacts };
    // The title is generated in parallel and pushed independently of the turn
    // event stream — nothing to do here.
  }

  /**
   * Fire-and-forget memory extraction after a turn (only when autoExtract is on).
   * Never blocks the reply; failures are logged and swallowed.
   */
  private maybeExtractMemory(sessionId: string, userText: string, ws?: string): void {
    const settings = loadSettings();
    if (!settings.memory.autoExtract) return;
    const scopeKey = ws || settings.model.workspaceDir || DEFAULT_WORKSPACE_DIR;
    void this.runMemoryExtraction(sessionId, userText, scopeKey);
  }

  /**
   * AUDN-style extraction: distill durable facts from the user's message, then
   * skip any candidate that already has a near-identical active memory (the
   * Noop branch). Add/Update/Delete resolution is delegated to the model in a
   * later stage; MVP keeps it to deduplicated Add.
   */
  private async runMemoryExtraction(
    sessionId: string,
    userText: string,
    scopeKey: string,
  ): Promise<void> {
    try {
      const settings = loadSettings();
      const model = createChatModel(settings.model);
      const sys = `You distill durable, cross-session facts from a single user message.
Output ONLY a JSON array (no prose) of objects: {"content":"one concise sentence"}.
Include only facts worth remembering long-term (user preferences, stable context, notable decisions or events). If nothing worth remembering, return [].
Respond in the same language as the user.`;
      const resp = await model.invoke([
        { role: "system", content: sys },
        { role: "user", content: userText },
      ]);
      const raw = (resp as { content?: unknown }).content;
      const text = typeof raw === "string" ? raw : "";
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return;
      const candidates = JSON.parse(match[0]) as Array<{
        content?: string;
      }>;
      // Quick dedup against existing MD profile to avoid exact repeats
      const existing = readRawMemory().toLowerCase();
      for (const c of candidates) {
        if (!c.content || !c.content.trim()) continue;
        const trimmed = c.content.trim();
        // Skip if a substantially similar sentence already exists in the profile
        if (existing.includes(trimmed.slice(0, 30).toLowerCase())) continue;
        appendToRecent(trimmed, `session:${sessionId}`);
      }
    } catch (err) {
      logger.warn("memory", "extraction failed", {
        session: sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Fire-and-forget timeline capture after every turn (always on, unlike the
   * opt-in autoExtract). Distills this turn's user+assistant exchange into a
   * few bullet points and appends them to today's timeline memory file, so the
   * day accumulates every project's conversations.
   */
  private maybeAppendTimeline(
    sessionId: string,
    userText: string,
    replyText: string,
    ws?: string,
  ): void {
    void this.runTimelineCapture(sessionId, userText, replyText, ws);
  }

  private async runTimelineCapture(
    sessionId: string,
    userText: string,
    replyText: string,
    ws?: string,
  ): Promise<void> {
    try {
      if (!userText || !userText.trim()) return;
      logger.info("timeline", "capture_start", { session: sessionId });
      const settings = loadSettings();
      const model = createChatModel(settings.model);
      const sys = `You are logging a daily work-session timeline. From the user's latest message and the assistant's reply, extract the key points worth keeping as a memory of this conversation: decisions made, conclusions reached, tasks attempted or completed, important facts learned, and any open questions.
Output ONLY a concise list of points (one short sentence per line, no numbering, no bullet markers, no code fences), in the same language as the user. If the conversation was trivial or small-talk, output a single short line summarizing what was discussed.`;
      const resp = await model.invoke([
        { role: "system", content: sys },
        {
          role: "user",
          content: `User message:\n${userText}\n\n---\nAssistant reply:\n${replyText}`,
        },
      ]);
      const raw = (resp as { content?: unknown }).content;
      const text = typeof raw === "string" ? raw : "";
      const points = text
        .trim()
        .replace(/^```[a-z]*\n?/i, "")
        .replace(/\n?```$/i, "")
        .split("\n")
        .map((l) => l.replace(/^[-*]\s*/, "").trim())
        .filter((l) => l.length > 0);
      if (points.length === 0) return;
      const project = ws ? path.basename(ws) : "(默认工作区)";
      appendTimelineEntry({ project, points });
      logger.info("timeline", "capture_done", { session: sessionId, project, pointsCount: points.length });
    } catch (err) {
      logger.warn("timeline", "capture failed", {
        session: sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
      modelId ?? this.sessionModel.get(sessionId),
    );
    logger.debug(
      "agent",
      "model_resolved",
      { session: sessionId, model: modelId ?? this.sessionModel.get(sessionId) },
      sessionId,
    );

    const emitter = new EventEmitter();
    registerTurnEmitter(sessionId, emitter);

    // Generate the session title on its own independent Promise, fully
    // detached from the turn's event stream. When it finishes it pushes a
    // session_renamed event directly via the injected sender, so the UI
    // refreshes regardless of whether the turn is still running.
    // Defer with setImmediate so any synchronous model setup does not compete
    // with the agent's first token delivery.
    if (userText) {
      setImmediate(() => {
        void this.maybeGenerateTitle(sessionId, userText, modelId, [logHandler]);
      });
    }

    const queue: DeepWorkEvent[] = [];
    let waiter: ((() => void) | null) = null;
    let reasoningChars = 0;
    let reasoningText = "";
    const tStreamStart = Date.now();
    let firstTokenMs: number | undefined;
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
      if (e.type === "reasoning_delta") {
        reasoningChars += e.text?.length ?? 0;
      } else if (e.type === "tool_call_finished") {
        // Refresh the artifact list after every tool call (write/edit/exec/…).
        // The file write is complete by the time tool_call_finished fires.
        // (Tool start/end/error are logged from the LangChain callback layer
        // in LoggingCallbackHandler, which also carries runId linkage.)
        scanArtifacts();
      }
      waiter?.();
    };
    emitter.on("event", onEvent);

    const logHandler = new LoggingCallbackHandler(sessionId, emitter);
    const ac = new AbortController();
    this.aborters.set(sessionId, ac);
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
    const consumed = (async () => {
      const t0 = Date.now();
      let firstToken = false;
      logger.info(
        "agent",
        "stream_start",
        { session: sessionId, model: modelId ?? this.sessionModel.get(sessionId) },
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
          model: modelId ?? this.sessionModel.get(sessionId),
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
      touchSession(sessionId);
    } catch (err) {
      if (ac.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        aborted = true;
      } else {
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
        yield {
          type: "turn_error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    } finally {
      this.aborters.delete(sessionId);
      emitter.removeListener("event", onEvent);
      unregisterTurnEmitter(sessionId);
    }
    return {
      replyText,
      aborted,
      tokens: {
        inputTokens: logHandler.totals.inputTokens,
        outputTokens: logHandler.totals.outputTokens,
        totalTokens: logHandler.totals.inputTokens + logHandler.totals.outputTokens,
      },
      llmCalls: logHandler.totals.calls,
      durationMs: Date.now() - tStreamStart,
      firstTokenMs,
      model: modelId ?? this.sessionModel.get(sessionId) ?? "unknown",
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
    const agent = await this.getAgentForModel(this.sessionModel.get(sessionId));
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

  /**
   * Resolve the chat model used for a session's title, reusing the session's
   * configured model (override or default). Falls back to the default
   * `chatModel` instance. Models are cached so repeated title calls are cheap.
   */
  private titleModel(modelId?: string): ReturnType<typeof createChatModel> | null {
    if (!modelId) return this.chatModel;
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
    const m = createChatModel(cfg);
    this.titleModels.set(key, m);
    return m;
  }

  /**
   * Generate a short title for a session after its first user message. Runs
   * once per session, fully asynchronously on its own Promise — independent of
   * the turn's event stream. When a title is produced (by AI or fallback) it
   * is persisted to the DB and pushed directly to the renderer via the injected
   * sender, so the UI refreshes even if the turn has already finished.
   */
  /**
   * Generate a short title for a session after its first user message.
   * Uses an optimistic + async-upgrade strategy:
   *  - Immediately publish a truncated title so the UI shows something at once
   *    (the title request is an independent model call that can be queued behind
   *    the main turn on the provider side, so it may arrive noticeably later).
   *  - Then run a background AI call; when it returns, publish the AI title to
   *    replace the truncated placeholder. If the AI call fails or is empty, the
   *    optimistic title simply stays.
   */
  private async maybeGenerateTitle(
    sessionId: string,
    userText: string,
    modelId?: string,
    callbacks?: unknown[],
  ): Promise<void> {
    if (this.titledSessions.has(sessionId)) return;
    this.titledSessions.add(sessionId);
    if (!userText.trim()) return;

    // The session already shows "New Chat" as its default placeholder title.
    // We deliberately do NOT push a truncated user-string — that flashes an
    // ugly partial title in the list. Instead the AI call runs in the
    // background and replaces "New Chat" only once the real title is ready.
    try {
      const model = this.titleModel(modelId);
      if (!model) return; // keep "New Chat"
      const prompt =
        "请根据用户的第一条消息，生成一句简短的会话标题用于列表展示。要求：\n" +
        "- 不超过 20 个字\n" +
        "- 概括用户的主要意图或任务\n" +
        "- 直接输出标题本身，不要加引号、编号、书名号或任何解释\n\n" +
        `用户：${userText.slice(0, 600)}`;
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
      let title = parts.join("");
      title = title
        .replace(/^(标题|title)\s*[:：]\s*/i, "")
        .replace(/^[《"「『'“”]+|[》"」』'”]+$/g, "")
        .replace(/^["'\s]+|["'\s]+$/g, "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 40);
      if (!title) return; // keep "New Chat"
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

  /** Persist and push a session_renamed event to the renderer. */
  private pushTitle(sessionId: string, title: string): void {
    renameSession(sessionId, title);
    try {
      this.send?.("chat:event", sessionId, { type: "session_renamed", title });
    } catch (e) {
      logger.error(
        "agent",
        "title_send_failed",
        { session: sessionId, error: e instanceof Error ? e.message : e },
        sessionId,
      );
    }
  }

  /** List all files in the session's output folder (the artifacts panel). */
  listArtifacts(sessionId: string): ArtifactFile[] {
    const s = getSession(sessionId);
    if (s && hasPickedWorkspace(s.workspaceDir)) {
      // Picked a project: the agent writes to the project root (its cwd), so
      // we must scan there — not just the isolated .deepwork/sessions drawer.
      // We scan the project root but skip source-tree noise.
      return this.scanArtifacts(path.resolve(s.workspaceDir!), true);
    }
    // Default isolated session: artifacts live in the per-session drawer.
    const root = sessionArtifactsDir(sessionId, s?.workspaceDir);
    if (!root) {
      const settings = loadSettings();
      const fallback = settings.model.workspaceDir || DEFAULT_WORKSPACE_DIR;
      if (!fallback) return [];
      return this.scanArtifacts(fallback, false);
    }
    return this.scanArtifacts(root, false);
  }

  private scanArtifacts(root: string, isProjectRoot = false): ArtifactFile[] {
    const out: ArtifactFile[] = [];
    // Directories to always skip.
    const skipDirs = new Set([
      "node_modules", ".git", ".venv", "dist", "build", "out",
      "__pycache__", ".next", ".nuxt", ".angular", "target", ".deepwork",
      // Source / config dirs that are not user-facing deliverables.
      ...(isProjectRoot
        ? ["src", "lib", "app", "components", "hooks", "utils", "types",
            "pages", "views", "routes", "store", "tests", "__tests__",
            "test", "spec", "docs", ".idea", ".vscode", ".DS_Store"]
        : []),
    ]);
    // Internal / transient files that are not user-facing artifacts.
    const skipFiles = new Set([
      "deepwork.log", "package.json", "tsconfig.json", "vite.config.*",
      "tailwind.config*", "postcss.config*", "next.config*",
      ".gitignore", ".eslintrc*", ".prettierrc*", "README*", "LICENSE*",
      "go.mod", "go.sum", "Cargo.toml", "pom.xml", "build.gradle",
      // Model call trace dumps (raw request/response text).
    ]);
    const skipExt = new Set(["log", ...(isProjectRoot
      ? ["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "vue",
         "svelte", "css", "scss", "less", "json", "yaml", "yml", "toml",
         "lock", "mod", "sum"]
      : [])]);
    const isInternal = (name: string): boolean => {
      if (skipFiles.has(name)) return true;
      if (name.startsWith("call_") && name.endsWith(".txt")) return true;
      return false;
    };
    const walk = (dir: string, depth: number): void => {
      if (depth > 3 || out.length > 300) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (skipDirs.has(e.name) || e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full, depth + 1);
        } else if (e.isFile() && !isInternal(e.name) && !skipExt.has(path.extname(e.name).replace(".", ""))) {
          let st: fs.Stats;
          try {
            st = fs.statSync(full);
          } catch {
            continue;
          }
          out.push({
            name: e.name,
            relativePath: path.relative(root, full),
            absolutePath: full,
            size: st.size,
            modifiedAt: st.mtimeMs,
            ext: path.extname(e.name).replace(".", "").toLowerCase(),
          });
        }
      }
    };
    walk(root, 0);
    return out.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 100);
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
    const agent = await this.getAgentForModel(this.sessionModel.get(sessionId));
    const config = { configurable: { thread_id: sessionId } };
    const state: any = await (agent as any).getState(config);
    const messages: any[] = state?.values?.messages ?? [];

    const timeline: HistoryItem[] = [];
    const toolResults = new Map<string, string>();
    let lastTodos: TodoItem[] = [];
    for (const m of messages) {
      const role = m._getType?.() ?? m.getType?.();
      if (role === "human") {
        const content = stringContent(m.content);
        if (content) timeline.push({ kind: "msg", role: "user", content });
      } else if (role === "ai" || role === "AIMessageChunk") {
        const text = stringContent(m.content);
        // Restore reasoning/thinking for reasoning models. Each LLM invocation
        // is persisted as a separate AIMessage with its own reasoning_content,
        // even when the message content is empty (tool-call planning messages).
        // Preserve them as standalone reasoning timeline entries so they survive
        // reload and interleave correctly with tool calls.
        const reasoning = extractReasoning(m.content, m.additional_kwargs);
        if (reasoning) {
          timeline.push({
            kind: "reasoning",
            text: reasoning.slice(0, 8000),
            phase: m.tool_calls?.length ? "tool" : "final",
          });
        }
        if (text) {
          timeline.push({
            kind: "msg",
            role: "assistant",
            content: text,
          });
        }
        for (const tc of m.tool_calls ?? []) {
          if (!tc?.id) continue;
          if (tc.name === "write_todos") {
            const parsed = parseTodos(tc.args);
            if (parsed) lastTodos = parsed;
          }
          timeline.push({
            kind: "tool",
            id: tc.id,
            name: tc.name,
            argsPreview: preview(tc.args),
            status: "done" as const,
            outputPreview: toolResults.get(tc.id),
          });
        }
      } else if (role === "tool") {
        if (m.tool_call_id) toolResults.set(m.tool_call_id, preview(m.content));
      }
    }
    for (const item of timeline) {
      if (item.kind === "tool" && item.id && !item.outputPreview) {
        const out = toolResults.get(item.id);
        if (out) item.outputPreview = out;
      }
    }
    return { timeline, todos: lastTodos };
  }
}

function stringContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // For history, render document/image blocks as a short marker instead of dropping.
    return content
      .map((b) => {
        if (b?.type === "text" && typeof b.text === "string") return b.text;
        if (b?.type === "image_url") return "[image]";
        if (b?.type === "document") return "[document]";
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

function preview(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
  } catch {
    return String(v);
  }
}

/** Parse a write_todos tool call's arguments into TodoItems. */
function parseTodos(args: unknown): TodoItem[] | null {
  try {
    const raw = typeof args === "string" ? JSON.parse(args) : args;
    const list = (raw as { todos?: unknown[] })?.todos;
    if (!Array.isArray(list)) return null;
    return list
      .map((t) => {
        const item = t as { content?: unknown; status?: unknown };
        const content = String(item.content ?? "").trim();
        const status =
          item.status === "in_progress" || item.status === "completed"
            ? item.status
            : "pending";
        return content ? { content, status } : null;
      })
      .filter((x): x is TodoItem => x !== null);
  } catch {
    return null;
  }
}

/** Pull token usage from a LangChain LLMResult for OpenAI/Anthropic/compat shapes. */
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

/** Pull a best-effort finish reason from an LLMResult. */
function extractFinishReason(output: any): string | undefined {
  const g = output?.generations?.[0]?.[0];
  return (
    g?.generationInfo?.finish_reason ??
    g?.message?.response_metadata?.finish_reason ??
    output?.llmOutput?.finish_reason ??
    undefined
  );
}

/**
 * LangChain callback that mirrors every LLM invocation (including the ones
 * deepagents fires internally — summarization, context, approval) into the
 * structured log. Captures model, provider, latency, token usage and finish
 * reason, and accumulates per-turn totals for the turn_completed line.
 */
class LoggingCallbackHandler extends BaseCallbackHandler {
  name = "deepwork-logger";
  private sessionId: string;
  private emitter?: EventEmitter;
  private startedAt = new Map<string, number>();
  private reasoningPhaseOpen = false;
  totals = { inputTokens: 0, outputTokens: 0, calls: 0 };

  constructor(sessionId: string, emitter?: EventEmitter) {
    super();
    this.sessionId = sessionId;
    this.emitter = emitter;
  }

  handleLLMStart(llm: any, prompts: string[], runId: string): void {
    const id = Array.isArray(llm?.id) ? llm.id : [];
    const provider = id[2] ?? id.at(-1);
    const model = llm?.kwargs?.model ?? id.at(-1);
    this.startedAt.set(runId, Date.now());
    // Each handleLLMStart marks the beginning of a new model invocation.
    // Close any still-open reasoning phase (defensive) and start a fresh one;
    // the UI will drop empty phases for non-reasoning models on finish.
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
    // The actual serialized prompt handed to the model (system prompt + history
    // + tool schemas) — this is what's really sent, unlike the top-level
    // input.messages recorded by call_input. Verbose field, kept intact.
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
    // Close the reasoning phase that opened in handleLLMStart for this call.
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
    // DEBUG: the model's actual response text (truncated). For reasoning models
    // the reasoning lives in the stream blocks, captured separately at stream_end.
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
    // Make sure the UI closes the reasoning phase even on error.
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

  /**
   * LangGraph runs the agent as a graph; every node (planner, react loop,
   * retrieval, …) enters/exits as a "chain". These hooks trace which subgraph
   * ran, for how long, and with roughly how much data in/out — the fastest way
   * to see where a turn is spending its time.
   */
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

  /**
   * Tool calls at the LangChain layer. Carries runId + parentRunId so each
   * tool invocation can be linked back to the exact model call that decided
   * it — building the model→tool call tree used for debugging failures.
   */
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
   "create", "search", "子", "规划") — those are internal, not user-facing.

When a task requires a consequential action (writing files, running commands,
network actions, any GUI action), you will be asked to approve it through the
user. Report results concisely.`;

export const agentManager = new AgentManager();
