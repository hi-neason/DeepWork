import path from "node:path";
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
import i18n from "../i18n";
import type { DeepAgent } from "deepagents";
import type { StructuredToolInterface } from "@langchain/core/tools";

import { classifyModelError, createChatModel } from "./model";
import { listSessionArtifacts } from "./artifacts";
import { SessionRuntime } from "./sessionRuntime";
import { TurnRuntime } from "./turnRuntime";
import { projectHistory } from "./history";
import { createApprovalMiddleware } from "./middleware";
import { createSanitizeMiddleware, setThreadRoot } from "./sanitize";
import { createContextMiddleware } from "./context";
import { registerTurnEmitter, unregisterTurnEmitter } from "./turnEvents";
import { EventProjector } from "./eventProjector";
import { PostTurnService } from "./postTurn";
import { approvals } from "../security/approvals";
import { logger } from "../log/logger";
import { McpManager } from "../mcp/manager";
import { getSession, renameSession } from "../storage/sessions";
import type {
  ArtifactFile,
  Attachment,
  DeepWorkEvent,
  HistoryItem,
  PermissionMode,
  TodoItem,
  TurnStatus,
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

/** Shared empty set for sessions with no "always allow" grants yet. */
const EMPTY_ALWAYS_ALLOW: ReadonlySet<string> = new Set<string>();

/** Max distinct title-generation chat models kept alive at once (M-Agent③). */
const TITLE_MODEL_CACHE_MAX = 8;

/**
 * Builds and owns the deepagents agent. Rebuilt when settings (model / MCP /
 * workspace) change. Runs a single turn at a time per session.
 */
export class AgentManager {
  private mcp = new McpManager();
  private checkpointer: SqliteSaver | null = null;
  /** Ephemeral per-session workspace, model, permission, and grant state. */
  private runtime = new SessionRuntime();
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
    sanitize: unknown;
    summarization: unknown;
    context: unknown;
    approval: unknown;
    /** Ordered middleware passed to the agent. */
    middleware: unknown[];
    stateSchema: StateSchemaT;
    defaultWorkspace: string;
  } | null = null;
  /** The active skills middleware instance (rebuilt on skill changes). */
  private skillsMiddleware: ReturnType<typeof createSkillsMiddleware> | null = null;
  /** Active turn identity, cancellation, and lifecycle ownership. */
  private turns = new TurnRuntime();
  /** Best-effort post-turn memory and timeline capture. */
  private postTurn = new PostTurnService();
  /** Cache of one LocalShellBackend per workspace root. */
  private backends = new Map<string, LocalShellBackend>();

  /** Wire up the renderer sender so title updates can be pushed independently. */
  setSender(send: (channel: string, ...args: unknown[]) => void): void {
    this.send = send;
  }

  private backendFor(root: string): LocalShellBackend {
    const key = root || DEFAULT_WORKSPACE_DIR;
    let b = this.backends.get(key);
    if (!b) {
      // virtualMode confines the *filesystem tools* (read/write/edit/ls/glob)
      // to rootDir: absolute paths are rewritten inside the session folder and
      // ".." traversal is rejected, so files produced by those tools land in
      // <workspace>/<sessionId>/.
      //
      // ⚠️ It is NOT an OS sandbox. `execute` spawns a real shell with the
      // user's full privileges — it merely starts in rootDir and can still
      // read/write anywhere the user can (`cat ~/.ssh/id_rsa`, `cd /`).
      // The approval gate (exec risk) is the actual control here, which is why
      // `execute` must never be auto-allowed without the user seeing it.
      b = new LocalShellBackend({ rootDir: key, virtualMode: true });
      this.backends.set(key, b);
    }
    return b;
  }

  /** Resolve the workspace for a session (session override or settings default). */
  resolveWorkspace(sessionId: string, fallback: string): string {
    return this.runtime.getWorkspace(sessionId) || fallback;
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

    // Risk annotations MUST be registered before MCP tools are built: MCP
    // tools are annotated `external` inside buildTools, and annotateRisk is
    // monotonic, so running this block afterwards could otherwise downgrade a
    // same-named MCP tool back to `write`/`read` (C-T4).
    // deepagents built-in fs tools: write/edit/execute are write/exec risk.
    annotateRisk("write_file", "write");
    annotateRisk("edit_file", "write");
    annotateRisk("execute", "exec");
    annotateRisk("web_search", "external");
    annotateRisk("web_fetch", "external");
    annotateRisk("remember", "write");
    annotateRisk("forget", "write");
    annotateRisk("list_memories", "read");
    annotateRisk("write_todos", "read");

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

    const scopeKey = defaultWorkspace;
    const self = this;
    const approvalMiddleware = createApprovalMiddleware({
      getAlwaysAllow: (threadId?: string) =>
        (threadId ? this.runtime.getAlwaysAllowed(threadId) : undefined) ??
        EMPTY_ALWAYS_ALLOW,
      onAlwaysAllow: (name, threadId) => {
        // No thread id → we can't scope the grant, so don't persist it at all
        // (fail-closed: the tool still ran once, with explicit approval).
        if (!threadId) return;
        this.runtime.allowTool(threadId, name);
      },
      getMode: (threadId?: string) =>
        (threadId ? this.runtime.getMode(threadId) : undefined) ??
        loadSettings().permissionMode,
      isUnattended: (threadId) => this.runtime.isUnattended(threadId),
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
    const sanitizeMw = createSanitizeMiddleware();
    const contextMw = createContextMiddleware({
      getMode: (threadId?: string) =>
        (threadId ? this.runtime.getMode(threadId) : undefined) ??
        loadSettings().permissionMode,
      getWorkspace: (threadId?: string) =>
        threadId ? this.runtime.getWorkspace(threadId) : undefined,
      getProjectWorkspace: (threadId?: string) =>
        threadId ? this.runtime.getProjectWorkspace(threadId) : undefined,
    });
    this.shared = {
      tools,
      sanitize: sanitizeMw,
      summarization,
      context: contextMw,
      approval: approvalMiddleware,
      // Order matters: sanitize → summarization → skills → context → approval.
      // Skills is rebuilt in place by rebuildSkills(); the other pieces are
      // stable so we don't rely on a hard-coded index (M-Agent①).
      middleware: [
        sanitizeMw,
        summarization,
        this.skillsMiddleware!,
        contextMw,
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
    let baseUrl = settings.model.baseUrl;
    if (modelId) {
      if (modelId.includes(":")) {
        const [p, ...rest] = modelId.split(":");
        provider = p as typeof provider;
        modelName = rest.join(":");
      } else {
        modelName = modelId;
      }
      // Honor a per-model endpoint if the configured model carries one (e.g. a
      // Volcengine Ark general chat model on /api/v3 vs. the coding endpoint).
      const cfg = settings.configuredModels.find((m) => m.id === modelId);
      if (cfg?.baseUrl) baseUrl = cfg.baseUrl;
    }
    const key = modelId ?? `${provider}:${modelName}`;
    const existing = this.agents.get(key);
    if (existing) return existing;
    const model = createChatModel({
      ...settings.model,
      provider,
      model: modelName,
      ...(baseUrl ? { baseUrl } : {}),
    });
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
    // Model config/endpoints may have changed; drop cached title models so the
    // next call rebuilds them with fresh settings (M-Agent③).
    this.titleModels.clear();
    // Drop the old checkpointer so a fresh one is opened on the next build;
    // otherwise repeated rebuilds leak SQLite connections (M-Agent②).
    this.checkpointer = null;
    this.shared = null;
    this.runtime.clearAlwaysAllowed();
    await this.ensureAgent();
  }

  /** Per-server MCP connection outcomes from the most recent agent build. */
  getMcpStatus() {
    return this.mcp.getLastStatus();
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
      const prevSkills = this.skillsMiddleware;
      this.skillsMiddleware = createSkillsMiddleware({
        backend: new FilesystemBackend({
          rootDir: skillsSourcePath().replace(/\/$/, ""),
          virtualMode: true,
        }),
        sources: ["/"],
      });
      // Replace the skills entry by identity (stable neighbors), not a
      // hard-coded index (M-Agent①).
      this.shared.middleware = this.shared.middleware.map((m) =>
        m === prevSkills ? this.skillsMiddleware : m,
      );
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
        void this.maybeGenerateTitle(sessionId, userText, modelId, [logHandler]);
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
    // Bound the title-model cache (M-Agent③): distinct model ids accumulate
    // across a long-lived session; evict the oldest entry past a small cap.
    if (this.titleModels.size > TITLE_MODEL_CACHE_MAX) {
      const oldest = this.titleModels.keys().next().value;
      if (oldest !== undefined) this.titleModels.delete(oldest);
    }
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
      let title = parts.join("");
      title = title
        .replace(/^(title)\s*[:：]\s*/i, "")
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
