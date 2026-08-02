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

export type PermissionMode = "manual" | "auto" | "plan";

/** A model entry configured for a provider (enabled => shown in picker). */
export interface ConfiguredModel {
  id: string;
  provider: ProviderKind;
  enabled: boolean;
  isDefault?: boolean;
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

export interface MemoryItem {
  id: string;
  content: string;
  scope: "global" | "workspace" | "session";
  createdAt: number;
}

export type AutomationStatus = "scheduled" | "running" | "success" | "error";

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
  /** cron expression or "once" */
  schedule: string;
  /** ISO timestamp for one-shot tasks */
  runAt?: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastStatus?: AutomationStatus;
}

export interface Settings {
  model: ModelConfig;
  /** Models verified/configured per provider; enabled ones appear in the picker. */
  configuredModels: ConfiguredModel[];
  mcpServers: McpServerConfig[];
  /**
   * "manual" (default): ask before write/exec/external tools; GUI tools always ask.
   * "auto": auto-approve write/exec/external tools; GUI tools still require per-use approval.
   * "plan": read-only planning mode — write/exec/GUI tools are blocked and the agent
   *         should present a plan for approval.
   */
  permissionMode: PermissionMode;
  /** Legacy field, migrated to permissionMode. */
  approvalMode?: "manual" | "auto";
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
  /** Global memory entries injected into the system prompt (denormalized for renderer). */
  memories: MemoryItem[];
}

/** Settings sections shown in the settings sidebar. */
export type SettingsTab = "general" | "models" | "memory" | "shortcuts" | "about";

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Group/folder this task belongs to (default group: "默认"). */
  group: string;
  /** Per-session workspace directory; groups sessions and scopes the agent. */
  workspaceDir?: string;
  /** Per-session model override (provider:model or just model id). */
  model?: string;
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
}

export type SessionSort = "recent" | "title" | "created";

export type RiskLevel = "read" | "write" | "exec" | "external";

export type DeepWorkEvent =
  | { type: "message_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_started"; id: string; name: string; argsPreview: string }
  | { type: "tool_call_finished"; id: string; name: string; outputPreview: string; isError?: boolean }
  | {
      type: "approval_requested";
      id: string;
      name: string;
      risk: RiskLevel;
      argsPreview: string;
    }
  | { type: "session_renamed"; title: string }
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
  kind: "msg" | "tool";
  role?: "user" | "assistant";
  content?: string;
  id?: string;
  name?: string;
  argsPreview?: string;
  status?: "running" | "done";
  outputPreview?: string;
  isError?: boolean;
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
