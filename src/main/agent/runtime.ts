import path from "node:path";
import {
  createDeepAgent,
  LocalShellBackend,
  StateBackend,
  FilesystemBackend,
  createSummarizationMiddleware,
  createSkillsMiddleware,
} from "deepagents";
import type { DeepAgent } from "deepagents";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { StateSchema } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { z } from "zod";

import i18n from "../i18n";
import { logger } from "../log/logger";
import { McpManager } from "../mcp/manager";
import { createApprovalMiddleware } from "./middleware";
import { createChatModel } from "./model";
import { createContextMiddleware } from "./context";
import { createSanitizeMiddleware } from "./sanitize";
import { SessionRuntime } from "./sessionRuntime";
import { screenshotTool } from "../tools/gui";
import {
  keyboardPressTool,
  keyboardTypeTool,
  mouseClickTool,
  mouseMoveTool,
} from "../tools/control";
import { annotateRisk } from "../tools/registry";
import { loadSettings } from "../storage/settings";
import { WEB_TOOLS } from "../tools/web";
import { createTodosTool } from "../tools/todos";
import { createMemoryTools } from "../tools/memory";
import { skillsSourcePath } from "../skills/store";
import { APP_DATA_DIR, DEFAULT_WORKSPACE_DIR } from "../config/paths";

type StateSchemaT = InstanceType<typeof StateSchema>;

const GUI_TOOLS = [
  screenshotTool.tool,
  mouseMoveTool.tool,
  mouseClickTool.tool,
  keyboardTypeTool.tool,
  keyboardPressTool.tool,
];

/** Shared empty set for sessions with no "always allow" grants yet. */
const EMPTY_ALWAYS_ALLOW: ReadonlySet<string> = new Set<string>();

export type ChatModel = ReturnType<typeof createChatModel>;

/**
 * Owns DeepAgent construction and model-specific compiled-agent caches.
 *
 * AgentManager controls turn/session orchestration; this service owns the
 * expensive runtime graph: MCP tools, middleware, checkpointer, and per-model
 * compiled agents.
 */
export class AgentRuntimeService {
  private mcp = new McpManager();
  private checkpointer: SqliteSaver | null = null;
  private building: Promise<void> | null = null;
  private agents = new Map<string, DeepAgent>();
  private shared: {
    tools: StructuredToolInterface[];
    sanitize: unknown;
    summarization: unknown;
    context: unknown;
    approval: unknown;
    middleware: unknown[];
    stateSchema: StateSchemaT;
    defaultWorkspace: string;
  } | null = null;
  private skillsMiddleware: ReturnType<typeof createSkillsMiddleware> | null = null;
  private backends = new Map<string, LocalShellBackend>();

  constructor(
    private readonly runtime: SessionRuntime,
    private readonly onDefaultModel?: (model: ChatModel) => void,
    private readonly systemPrompt?: string,
  ) {}

  async ensureAgent(): Promise<void> {
    if (this.shared) return;
    if (this.building) return this.building;
    this.building = this.build();
    try {
      await this.building;
    } finally {
      this.building = null;
    }
  }

  modelKey(cfg: { provider: string; model: string }): string {
    return `${cfg.provider}:${cfg.model}`;
  }

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
      const configured = settings.configuredModels.find((m) => m.id === modelId);
      if (configured?.baseUrl) baseUrl = configured.baseUrl;
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

  async rebuild(): Promise<void> {
    await this.mcp.close();
    this.agents.clear();
    this.checkpointer = null;
    this.shared = null;
    this.runtime.clearAlwaysAllowed();
    await this.ensureAgent();
  }

  getMcpStatus() {
    return this.mcp.getLastStatus();
  }

  async rebuildSkills(): Promise<void> {
    try {
      if (!this.shared) {
        await this.ensureAgent();
        return;
      }
      const prevSkills = this.skillsMiddleware;
      this.skillsMiddleware = this.createSkillsMiddleware();
      this.shared.middleware = this.shared.middleware.map((m) =>
        m === prevSkills ? this.skillsMiddleware : m,
      );
      this.agents.clear();
      const settings = loadSettings();
      const model = createChatModel(settings.model);
      this.onDefaultModel?.(model);
      this.agents.set(this.modelKey(settings.model), this.compileAgent(model));
      logger.info("agent", "skills_reloaded");
    } catch (err) {
      logger.error("agent", "skills_reload_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async build(): Promise<void> {
    const settings = loadSettings();
    const model = createChatModel(settings.model);
    this.onDefaultModel?.(model);

    const dbPath = path.join(APP_DATA_DIR, "checkpoints.db");
    this.checkpointer = SqliteSaver.fromConnString(dbPath);

    this.annotateBuiltInRisks();

    let mcpTools: StructuredToolInterface[] = [];
    try {
      mcpTools = await this.mcp.buildTools(settings.mcpServers);
    } catch (err) {
      logger.error("agent", "mcp_build_failed", {
        error: err instanceof Error ? err.message : err,
      });
      mcpTools = [];
    }

    const defaultWorkspace = settings.model.workspaceDir || DEFAULT_WORKSPACE_DIR;
    const scopeKey = defaultWorkspace;
    const approvalMiddleware = createApprovalMiddleware({
      getAlwaysAllow: (threadId?: string) =>
        (threadId ? this.runtime.getAlwaysAllowed(threadId) : undefined) ??
        EMPTY_ALWAYS_ALLOW,
      onAlwaysAllow: (name, threadId) => {
        if (!threadId) return;
        this.runtime.allowTool(threadId, name);
      },
      getMode: (threadId?: string) =>
        (threadId ? this.runtime.getMode(threadId) : undefined) ??
        loadSettings().permissionMode,
      isUnattended: (threadId) => this.runtime.isUnattended(threadId),
    });
    const summarization = createSummarizationMiddleware({
      model,
      backend: () => new StateBackend(),
      trigger: { type: "tokens", value: 120_000 },
      keep: { type: "messages", value: 20 },
      trimTokensToSummarize: 4000,
    });
    this.skillsMiddleware = this.createSkillsMiddleware();
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
    const sanitize = createSanitizeMiddleware();
    const context = createContextMiddleware({
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
      sanitize,
      summarization,
      context,
      approval: approvalMiddleware,
      middleware: [sanitize, summarization, this.skillsMiddleware, context, approvalMiddleware],
      stateSchema: stateSchema as unknown as StateSchemaT,
      defaultWorkspace,
    };
    this.agents.set(this.modelKey(settings.model), this.compileAgent(model));
  }

  private compileAgent(model: ChatModel): DeepAgent {
    if (!this.shared) throw new Error(i18n.t("errors.agentNotInitialized"));
    const { tools, middleware, stateSchema, defaultWorkspace } = this.shared;
    return createDeepAgent({
      model,
      tools,
      // deepagents' current public types lag the runtime StateSchema shape.
      stateSchema: stateSchema as any,
      backend: (runtime: any) =>
        this.backendFor(runtime?.state?.workspaceDir || defaultWorkspace),
      checkpointer: this.checkpointer!,
      middleware: middleware as any,
      systemPrompt: this.systemPrompt,
    });
  }

  private createSkillsMiddleware(): ReturnType<typeof createSkillsMiddleware> {
    return createSkillsMiddleware({
      backend: new FilesystemBackend({
        rootDir: skillsSourcePath().replace(/\/$/, ""),
        virtualMode: true,
      }),
      sources: ["/"],
    });
  }

  private backendFor(root: string): LocalShellBackend {
    const key = root || DEFAULT_WORKSPACE_DIR;
    let backend = this.backends.get(key);
    if (!backend) {
      // virtualMode confines the *filesystem tools* (read/write/edit/ls/glob)
      // to rootDir: absolute paths are rewritten inside the session folder and
      // ".." traversal is rejected, so files produced by those tools land in
      // the selected workspace/session output drawer.
      //
      // It is NOT an OS sandbox. `execute` spawns a real shell with the user's
      // full privileges; the approval gate (exec risk) is the actual control.
      backend = new LocalShellBackend({ rootDir: key, virtualMode: true });
      this.backends.set(key, backend);
    }
    return backend;
  }

  private annotateBuiltInRisks(): void {
    annotateRisk("write_file", "write");
    annotateRisk("edit_file", "write");
    annotateRisk("execute", "exec");
    annotateRisk("web_search", "external");
    annotateRisk("web_fetch", "external");
    annotateRisk("remember", "write");
    annotateRisk("forget", "write");
    annotateRisk("list_memories", "read");
    annotateRisk("write_todos", "read");
  }
}
