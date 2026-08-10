import { createMiddleware, ToolMessage } from "langchain";
import { riskOf, isSystemTool } from "../tools/registry";
import { approvals } from "../security/approvals";
import { audit } from "../storage/db";
import { emitTurnEvent } from "./turnEvents";
import type {
  ApprovalDecision,
  DeepWorkEvent,
  PermissionMode,
  RiskLevel,
} from "../../shared/types";

/** GUI tools always require per-use approval — never "always allow". */
const GUI_TOOLS = new Set([
  "screenshot",
  "mouse_move",
  "mouse_click",
  "keyboard_type",
  "keyboard_press",
]);

/** Tools that mutate state / act on the world — blocked while in plan mode. */
const MUTATING_TOOLS = new Set([
  "write_file",
  "edit_file",
  "execute",
  "screenshot",
  "mouse_move",
  "mouse_click",
  "keyboard_type",
  "keyboard_press",
  "send_message",
  "send_file",
]);

function needsApproval(risk: RiskLevel, toolName: string): boolean {
  if (GUI_TOOLS.has(toolName)) return true;
  if (isSystemTool(toolName)) return false;
  return risk === "write" || risk === "exec" || risk === "external";
}

// Pure, framework-agnostic approval decision. Extracted so the 5-gate policy
// can be unit-tested without the langchain middleware runtime, db, or electron.
export type ApprovalAction = "block" | "ask" | "allow";
export interface ApprovalVerdict {
  action: ApprovalAction;
  blockReason?:
    | "plan-mode"
    | "unattended-gui"
    | "unattended-highrisk";
}
export interface ApprovalContext {
  toolName: string;
  risk: RiskLevel;
  mode: PermissionMode;
  unattended: boolean;
  /** Whether this specific tool is on the "always allow" list. */
  alwaysAllowed: boolean;
}

export function evaluateApprovalDecision(ctx: ApprovalContext): ApprovalVerdict {
  const { toolName, risk, mode, unattended, alwaysAllowed } = ctx;
  // Plan mode: anything that changes state is blocked outright.
  if (mode === "plan" && MUTATING_TOOLS.has(toolName)) {
    return { action: "block", blockReason: "plan-mode" };
  }
  // Unattended runs (scheduled automations) have no user to prompt. GUI tools
  // are impossible to approve, and the highest-risk tiers — shell execution
  // and third-party/network (MCP) tools — are blocked outright. Without this,
  // `auto` mode + a web_fetch content-injection could run arbitrary shell
  // commands with no human in the loop (H-T4). write-level tools may still run
  // in `auto` mode (the automation opted into it); everything else is denied.
  if (unattended) {
    if (GUI_TOOLS.has(toolName)) {
      return { action: "block", blockReason: "unattended-gui" };
    }
    if (risk === "exec" || risk === "external") {
      return { action: "block", blockReason: "unattended-highrisk" };
    }
  }
  // GUI tools always ask. New automatic modes grant the minimum useful risk
  // tier; the historical broad `auto` value remains readable for users with
  // saved settings from earlier versions.
  const autoAllowed =
    !GUI_TOOLS.has(toolName) &&
    (mode === "auto" ||
      (mode === "auto-write" && risk === "write") ||
      (mode === "auto-exec" && (risk === "write" || risk === "exec")));
  const mustAsk =
    !autoAllowed &&
    needsApproval(risk, toolName) &&
    (GUI_TOOLS.has(toolName) || !alwaysAllowed);
  return mustAsk ? { action: "ask" } : { action: "allow" };
}

// Args can embed full file contents (write_file); keep them compact. Output
// (e.g. command logs) is what users expand a card to read, so allow much more.
const ARGS_PREVIEW_LIMIT = 800;
const OUTPUT_PREVIEW_LIMIT = 20_000;

function truncate(s: string, limit: number): string {
  return s.length > limit ? s.slice(0, limit) + "…" : s;
}

function previewArgs(args: unknown): string {
  try {
    return truncate(JSON.stringify(args), ARGS_PREVIEW_LIMIT);
  } catch {
    return String(args);
  }
}

function isTextBlock(b: unknown): b is { type: "text"; text: string } {
  return (
    typeof b === "object" &&
    b !== null &&
    (b as { type?: unknown }).type === "text" &&
    typeof (b as { text?: unknown }).text === "string"
  );
}

function previewContent(content: unknown): string {
  if (typeof content === "string") return truncate(content, OUTPUT_PREVIEW_LIMIT);
  if (Array.isArray(content)) {
    const text = content
      .filter(isTextBlock)
      .map((b) => b.text)
      .join(" ");
    return text ? truncate(text, OUTPUT_PREVIEW_LIMIT) : "[non-text result]";
  }
  return "[result]";
}

export interface MiddlewareDeps {
  /** "Always allow" grants for one session (H-T2: never global). */
  getAlwaysAllow: (threadId?: string) => ReadonlySet<string>;
  onAlwaysAllow: (toolName: string, threadId?: string) => void;
  getMode: (threadId?: string) => PermissionMode;
  isUnattended: (threadId: string) => boolean;
}

export function createApprovalMiddleware(deps: MiddlewareDeps) {
  const { getAlwaysAllow, onAlwaysAllow, getMode, isUnattended } = deps;
  return createMiddleware({
    name: "deepwork_approval",
    wrapToolCall: async (request: any, handler: any) => {
      const toolCall = request.toolCall as { id: string; name: string; args: unknown };
      // The langchain middleware runtime exposes the LangGraph thread_id on
      // `runtime.configurable` (NOT `request.config`, which is undefined here).
      // Without it emitTurnEvent silently drops every live tool event.
      const threadId: string | undefined =
        request.runtime?.configurable?.thread_id ??
        request.runtime?.config?.configurable?.thread_id ??
        request.config?.configurable?.thread_id;
      const risk = riskOf(toolCall.name);
      const argsPreview = previewArgs(toolCall.args);
      const mode = getMode(threadId);

      const emit = (e: DeepWorkEvent) => emitTurnEvent(threadId, e);
      emit({ type: "tool_call_started", id: toolCall.id, name: toolCall.name, argsPreview });

      const verdict = evaluateApprovalDecision({
        toolName: toolCall.name,
        risk,
        mode,
        unattended: threadId ? isUnattended(threadId) : false,
        alwaysAllowed: getAlwaysAllow(threadId).has(toolCall.name),
      });

      if (verdict.action === "block") {
        const reason = verdict.blockReason;
        const isUnattendedGui = reason === "unattended-gui";
        const isUnattendedHighRisk = reason === "unattended-highrisk";
        let msg: string;
        let preview: string;
        if (isUnattendedGui) {
          msg = `GUI tool "${toolCall.name}" cannot run unattended (no user to approve).`;
          preview = "Blocked: GUI actions need interactive approval.";
        } else if (isUnattendedHighRisk) {
          msg =
            `High-risk tool "${toolCall.name}" (${risk}) is blocked in unattended runs — ` +
            `shell/third-party tools require an interactive user for safety.`;
          preview = "Blocked: high-risk action cannot run unattended.";
        } else {
          msg =
            `Plan mode is active — the "${toolCall.name}" action is blocked. ` +
            `Continue exploring with read-only tools, then present the plan to the user for approval.`;
          preview = "Blocked (plan mode)";
        }
        emit({
          type: "tool_call_finished",
          id: toolCall.id,
          name: toolCall.name,
          outputPreview: preview,
          isError: true,
        });
        return new ToolMessage({
          content: msg,
          tool_call_id: toolCall.id,
          name: toolCall.name,
        });
      }

      let decision: ApprovalDecision = "allow";
      if (verdict.action === "ask") {
        // Screenshot captures the full screen and ships it to the external
        // vision model; warn the approver that sensitive content may leave
        // the machine.
        const warning =
          toolCall.name === "screenshot" ? "screenshot_exfil" : undefined;
        emit({ type: "approval_requested", id: toolCall.id, name: toolCall.name, risk, argsPreview, warning });
        const d = await approvals.requestWithId(
          toolCall.id,
          { tool: toolCall.name, risk, argsPreview, sessionId: threadId },
          // Cancel the pending approval when the turn is aborted, so a cancelled
          // turn doesn't leave a dangling approval promise (H-A1/H-T3).
          { signal: request.signal as AbortSignal | undefined },
        );
        decision = GUI_TOOLS.has(toolCall.name) && d === "always_allow" ? "allow" : d;
      }

      audit({
        sessionId: threadId,
        tool: toolCall.name,
        risk,
        argsPreview,
        decision,
      });

      if (decision === "deny") {
        emit({
          type: "tool_call_finished",
          id: toolCall.id,
          name: toolCall.name,
          outputPreview: "Denied by user.",
          isError: true,
        });
        return new ToolMessage({
          content: `User denied the "${toolCall.name}" action. Do not retry without asking.`,
          tool_call_id: toolCall.id,
          name: toolCall.name,
        });
      }

      if (decision === "always_allow") {
        onAlwaysAllow(toolCall.name, threadId);
      }

      try {
        const result = await handler(request);
        const outputPreview = ToolMessage.isInstance(result)
          ? previewContent(result.content)
          : "[done]";
        emit({
          type: "tool_call_finished",
          id: toolCall.id,
          name: toolCall.name,
          outputPreview,
        });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({
          type: "tool_call_finished",
          id: toolCall.id,
          name: toolCall.name,
          outputPreview: msg,
          isError: true,
        });
        return new ToolMessage({
          content: `Tool "${toolCall.name}" failed: ${msg}`,
          tool_call_id: toolCall.id,
          name: toolCall.name,
        });
      }
    },
  });
}
