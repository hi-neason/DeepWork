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

function previewContent(content: unknown): string {
  if (typeof content === "string") return truncate(content, OUTPUT_PREVIEW_LIMIT);
  if (Array.isArray(content)) {
    const text = content
      .filter((b) => (b as any)?.type === "text")
      .map((b) => (b as any).text)
      .join(" ");
    return text ? truncate(text, OUTPUT_PREVIEW_LIMIT) : "[non-text result]";
  }
  return "[result]";
}

export interface MiddlewareDeps {
  getAlwaysAllow: () => Set<string>;
  onAlwaysAllow: (toolName: string) => void;
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

      // Plan mode: read/explore tools run freely, anything that changes state is
      // blocked outright so the agent can plan without side effects.
      if (mode === "plan" && MUTATING_TOOLS.has(toolCall.name)) {
        const msg =
          `Plan mode is active — the "${toolCall.name}" action is blocked. ` +
          `Continue exploring with read-only tools, then present the plan to the user for approval.`;
        emit({
          type: "tool_call_finished",
          id: toolCall.id,
          name: toolCall.name,
          outputPreview: "Blocked (plan mode)",
          isError: true,
        });
        return new ToolMessage({
          content: msg,
          tool_call_id: toolCall.id,
          name: toolCall.name,
        });
      }

      let decision: ApprovalDecision = "allow";
      const alwaysAllowed = getAlwaysAllow();
      const unattended = threadId ? isUnattended(threadId) : false;
      // In auto mode OR an unattended (scheduled) run, non-GUI write/exec/external
      // tools run without prompting. GUI tools always require per-use approval —
      // in an unattended run they can't prompt, so they're denied.
      const autoAllowed = (mode === "auto" || unattended) && !GUI_TOOLS.has(toolCall.name);
      if (unattended && GUI_TOOLS.has(toolCall.name)) {
        emit({
          type: "tool_call_finished",
          id: toolCall.id,
          name: toolCall.name,
          outputPreview: "Blocked: GUI actions need interactive approval.",
          isError: true,
        });
        return new ToolMessage({
          content: `GUI tool "${toolCall.name}" cannot run unattended (no user to approve).`,
          tool_call_id: toolCall.id,
          name: toolCall.name,
        });
      }
      const mustAsk =
        !autoAllowed &&
        needsApproval(risk, toolCall.name) &&
        (GUI_TOOLS.has(toolCall.name) || !alwaysAllowed.has(toolCall.name));
      if (mustAsk) {
        emit({ type: "approval_requested", id: toolCall.id, name: toolCall.name, risk, argsPreview });
        const d = await approvals.requestWithId(toolCall.id, {
          tool: toolCall.name,
          risk,
          argsPreview,
        });
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
        onAlwaysAllow(toolCall.name);
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
