// Types shared between main and renderer processes.

export type ProviderKind =
  | "anthropic"
  | "openai"
  | "ollama"
  | "deepseek"
  | "qwen"
  | "minimax"
  | "kimi"
  | "openrouter"
  | "custom";

/** The four permission modes exposed by the product UI. */
export const INTERACTIVE_PERMISSION_MODES = [
  "manual",
  "auto-write",
  "auto-exec",
  "plan",
] as const;
export type InteractivePermissionMode = (typeof INTERACTIVE_PERMISSION_MODES)[number];

/**
 * `auto` is retained only for compatibility with settings saved by older
 * versions. New chats persist one of the four interactive modes above.
 */
export type PermissionMode = InteractivePermissionMode | "auto";

/** A model entry configured for a provider (enabled => shown in picker). */
export interface ConfiguredModel {
  id: string;
  provider: ProviderKind;
  enabled: boolean;
  isDefault?: boolean;
  /** Endpoint this model was configured with. Stored so a model can be used
   *  with its own base URL (e.g. a Volcengine Ark general chat model on
   *  /api/v3) rather than the global active endpoint. */
  baseUrl?: string;
}

export interface ModelConfig {
  provider: ProviderKind;
  /** Model id, e.g. "claude-sonnet-4-5" or "gpt-4o" or "qwen2.5" */
  model: string;
  /** Base URL override (for OpenAI-compatible or Ollama) */
  baseUrl?: string;
  /** Workspace directory the agent is allowed to read/write */
  workspaceDir: string;
}

export interface McpServerConfig {
  id: string;
  label: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
}

/** Per-server outcome of the last MCP build, surfaced to the Connectors UI. */
export interface McpServerStatus {
  id: string;
  label: string;
  ok: boolean;
  error?: string;
  toolCount?: number;
}

/** A file attached to a user message. Stored as a data URL in transit. */
export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** data: URL for images; for PDFs we extract text on the main side. */
  dataUrl: string;
  kind: "image" | "pdf" | "text";
  /** Extracted text for pdf/text attachments. */
  text?: string;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ArtifactFile {
  name: string;
  relativePath: string;
  absolutePath: string;
  size: number;
  modifiedAt: number;
  ext: string;
}

export type MemoryType = "preference" | "fact" | "event";

export interface MemoryItem {
  id: string;
  content: string;
  scope: "global" | "workspace" | "session";
  createdAt: number;
  /** Classification for retrieval/display: stable preference, durable fact, or past event. */
  type?: MemoryType;
  /** 0..1 salience used for ranking and (optional) decay. */
  importance?: number;
  /** "active" normally; "invalid" when superseded by a newer memory. */
  status?: "active" | "invalid";
  /** Provenance waypoint, e.g. "session:<id>:turn:<n>". */
  source?: string;
}

export interface EmbeddingConfig {
  /** Provider used to compute embeddings. "none" disables semantic search. */
  provider: "ollama" | "openai" | "none";
  model: string;
  baseUrl?: string;
}

export interface MemoryConfig {
  /** Run the AUDN extraction pipeline after each turn. Off by default. */
  autoExtract: boolean;
  embedding: EmbeddingConfig;
  /** Max memories injected into the prompt each turn. */
  topK: number;
  /** Minimum cosine similarity (0..1) for semantic retrieval. */
  threshold: number;
}

export type AutomationStatus = "scheduled" | "running" | "success" | "error";

export type ScheduleType = "daily" | "weekly" | "cron" | "once";

/** Structured schedule configuration for an automation.
 *  - daily:   time: "HH:mm"
 *  - weekly:  days: [0..6] (0=Sun), time: "HH:mm"
 *  - cron:    cron: "0 9 * * 1-5"
 *  - once:    datetime: ISO string
 */
export interface AutomationScheduleConfig {
  time?: string;
  days?: number[];
  cron?: string;
  datetime?: string;
  /** IANA timezone the wall-clock schedule is anchored to (e.g. "Asia/Shanghai").
   *  When unset the scheduler uses the system local timezone. */
  timezone?: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  startedAt: number;
  finishedAt?: number;
  status: AutomationStatus;
  error?: string;
  sessionId?: string;
}

export interface Automation {
  id: string;
  title: string;
  instructions: string;
  /** Workspace directory this automation runs in. */
  workspaceDir?: string;
  scheduleType: ScheduleType;
  scheduleConfig: AutomationScheduleConfig;
  /** ISO date (YYYY-MM-DD). Inclusive. */
  validFrom?: string;
  /** ISO date (YYYY-MM-DD). Inclusive. */
  validUntil?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastStatus?: AutomationStatus;
  /** Consecutive failed runs; reset after a successful run. */
  consecutiveFailures?: number;
  /** Set when safety controls pause an automation after repeated failures. */
  autoPaused?: boolean;
  /** Permission mode used when the automation runs unattended. */
  permissionMode?: PermissionMode;
  /** Skill names to enable for this automation. */
  skills?: string[];
  /** MCP server ids to enable for this automation. */
  mcpServerIds?: string[];
  /** Model id (e.g. "openai:gpt-4o") to run this automation with. Empty/undefined
   *  means use the global default model. Honors the model's own endpoint if set. */
  model?: string;
}

export interface AutomationWithRuns extends Automation {
  runs: AutomationRun[];
}

export interface Settings {
  model: ModelConfig;
  /** Models verified/configured per provider; enabled ones appear in the picker. */
  configuredModels: ConfiguredModel[];
  mcpServers: McpServerConfig[];
  /**
   * "manual" (default): ask before write/exec/external tools; GUI tools always ask.
   * "auto-write": auto-approve file writes only; exec/external tools still ask.
   * "auto-exec": auto-approve writes and shell execution; external tools still ask.
   * "auto": legacy broad auto-approval, retained for existing settings only.
   * "plan": read-only planning mode — write/exec/GUI tools are blocked and the agent
   *         should present a plan for approval.
   */
  permissionMode: PermissionMode;
  /** Tools that should never require approval in this session */
  alwaysAllowTools: string[];
  /** Whether the first-run onboarding has completed. */
  onboarded: boolean;
  /** Minimize to tray instead of quitting on window close. */
  trayEnabled: boolean;
  /** Automatically download/install updates. */
  autoUpdate: boolean;
  /** Launch automatically when the user signs in. */
  openAtLogin: boolean;
  /** Keep the machine awake while a turn/automation is running. */
  keepAwake: boolean;
  /** UI theme. */
  theme: "light" | "dark" | "auto";
  /** Interface language (BCP-47-ish tag). */
  language: "zh-CN" | "en-US";
  /** UI font scale: 0.9 (small) .. 1.3 (large). 1 = default. */
  fontScale: number;
  /** Send message telemetry/error reports (no-op unless enabled). */
  telemetry: boolean;
  /** Show reasoning/thinking blocks inline instead of hiding them. */
  showReasoning: boolean;
  /** Enable playful easter-egg mini-games (e.g. the Commit Runner) on idle screens. */
  funMode: boolean;
  /** Write structured debug logs to <workspace>/sessions/<sessionId>/deepwork.log. */
  logEnabled: boolean;
  /** Memory subsystem configuration (auto-extraction, embedding backend, retrieval). */
  memory: MemoryConfig;
  /** Global memory entries injected into the system prompt (denormalized for renderer). */
  memories: MemoryItem[];
  /** Read AGENTS.md from workspace root and inject it into context. */
  includeAgentsMd: boolean;
  /** Read CLAUDE.md (+ CLAUDE.local.md) from workspace root and inject into context. */
  includeClaudeMd: boolean;
}

/** Settings sections shown in the settings sidebar. */
export type SettingsTab =
  | "general"
  | "models"
  | "memory"
  | "skills"
  | "connectors"
  | "automations"
  | "about";

/** A file inside a skill's directory (scripts, references, assets). */
export interface SkillFile {
  /** Relative path from the skill directory, e.g. "scripts/deploy.sh". */
  path: string;
  /** Bytes (files only). */
  size: number;
  /** One of "script" | "reference" | "asset" | "other". */
  kind: "script" | "reference" | "asset" | "other";
}

/** Origin of a session: a manually started chat, or one created by a scheduled
 *  automation run (hidden from the chat list, shown in run history). */
export type SessionSource = "user" | "automation";

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Origin: "user" chats show in the sidebar, "automation" sessions are
   *  created by scheduled runs and accessed via run history. Defaults to
   *  "user" for rows created before the column existed. */
  source: SessionSource;
  /** Group/folder this task belongs to (default group id: "Default"; the
   *  display label is localized via the sidebar.defaultGroup i18n key). */
  group: string;
  /** Explicit project folder chosen for the task; absent uses the configured default workspace. */
  workspaceDir?: string;
  /** Private per-session workspace containing generated artifacts. */
  rootDir?: string;
  /** Working directory for the embedded terminal; always the private session workspace. */
  terminalCwd?: string;
  /** Per-session model override (provider:model or just model id). */
  model?: string;
  /** Permission mode owned and persisted by this session. */
  permissionMode: InteractivePermissionMode;
}

/** A skill (SKILL.md) managed in the local skills directory. */
export interface Skill {
  /** Directory / skill id (kebab-case). */
  name: string;
  description: string;
  /** The markdown body after the frontmatter. */
  body: string;
  enabled: boolean;
  updatedAt: number;
  /** SPDX license identifier (optional). */
  license?: string;
  /** Compatibility / platform notes (optional). */
  compatibility?: string;
  /** Arbitrary key-value metadata from frontmatter. */
  metadata?: Record<string, string>;
  /** Tool names this skill is allowed to use (optional, experimental). */
  allowedTools?: string[];
  /** Files inside the skill directory (scripts/references/assets). */
  files: SkillFile[];
}

export type SessionSort = "recent" | "title" | "created";

export type RiskLevel = "read" | "write" | "exec" | "external";

/** Authoritative lifecycle state for a session's active agent turn. */
export type TurnState =
  | "idle"
  | "running"
  | "waiting_approval"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "error";

export interface TurnStatus {
  state: TurnState;
  turnId?: string;
  startedAt?: number;
}

/** Per-turn model/telemetry stats surfaced to the user under each reply. */
export interface TurnStats {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  llmCalls: number;
  durationMs: number;
  firstTokenMs?: number;
  finishReason?: string;
}

export type DeepWorkEvent =
  | { type: "turn_state"; status: TurnStatus }
  | { type: "message_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "reasoning_phase_started" }
  | { type: "reasoning_phase_finished"; phase: "tool" | "final" }
  | { type: "tool_call_started"; id: string; name: string; argsPreview: string }
  | { type: "tool_call_finished"; id: string; name: string; outputPreview: string; isError?: boolean }
  | {
      type: "approval_requested";
      id: string;
      name: string;
      risk: RiskLevel;
      argsPreview: string;
      /** Short data-handling warning shown on the approval card (e.g. screenshot sends screen contents to the model). */
      warning?: string;
    }
  | { type: "session_renamed"; title: string }
  | {
      type: "turn_stats";
      model: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      llmCalls: number;
      durationMs: number;
      firstTokenMs?: number;
      finishReason?: string;
    }
  | { type: "turn_completed" }
  | { type: "turn_aborted" }
  | { type: "turn_error"; message: string }
  | { type: "todos_updated"; todos: TodoItem[] }
  | { type: "artifacts_updated"; artifacts: ArtifactFile[] };

export type ApprovalDecision = "allow" | "deny" | "always_allow";

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

/** A reconstructed item from a session's persisted history. */
export interface HistoryItem {
  kind: "msg" | "tool" | "reasoning";
  role?: "user" | "assistant";
  content?: string;
  /** Model reasoning/thinking text, restored from history (reasoning models). */
  reasoning?: string;
  /** For kind="reasoning": the thinking text for this phase. */
  text?: string;
  /** For kind="reasoning": whether this phase preceded a tool call or the final answer. */
  phase?: "tool" | "final";
  /** Telemetry for assistant replies (only present for live turns). */
  stats?: TurnStats;
  id?: string;
  name?: string;
  argsPreview?: string;
  status?: "running" | "done";
  outputPreview?: string;
  isError?: boolean;
  /** Tool execution time in ms (live turns only). */
  durationMs?: number;
}

/** Curated model shown in the model picker. */
export interface ModelInfo {
  id: string;
  label: string;
  provider: ProviderKind;
  contextWindow: number;
  vision: boolean;
  tools: boolean;
  recommended?: boolean;
}

/** Result of verifying an API key / connection. */
export interface VerifyResult {
  ok: boolean;
  message: string;
  models?: string[];
}

/** Update status surfaced to the UI. */
export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "downloading"; percent: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string }
  | { state: "not-available" };
