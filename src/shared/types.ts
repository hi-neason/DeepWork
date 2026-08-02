// Types shared between main and renderer processes.

export type ProviderKind = "anthropic" | "openai" | "ollama";

export type ApprovalMode = "manual" | "auto";

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

export interface Settings {
  model: ModelConfig;
  mcpServers: McpServerConfig[];
  /**
   * "manual" (default): ask before write/exec/external tools; GUI tools always ask.
   * "auto": auto-approve write/exec/external tools; GUI tools still require per-use approval.
   */
  approvalMode: ApprovalMode;
  /** Tools that should never require approval in this session */
  alwaysAllowTools: string[];
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

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
  | { type: "turn_error"; message: string };

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
