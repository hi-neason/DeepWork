import { createMiddleware, ToolMessage } from "langchain";
import { EventEmitter } from "node:events";
import { riskOf, isSystemTool } from "../tools/registry";
import { approvals } from "../security/approvals";
import { audit } from "../storage/db";
import type { ApprovalDecision, DeepWorkEvent, RiskLevel } from "../../shared/types";

/** GUI tools always require per-use approval — never "always allow". */
const GUI_TOOLS = new Set(["screenshot", "mouse_move", "mouse_click", "keyboard_type", "keyboard_press"]);

/** Per-turn emitters keyed by LangGraph thread_id. */
const turnEmitters = new Map<string, EventEmitter>();

export function registerTurnEmitter(threadId: string, emitter: EventEmitter): void {
  turnEmitters.set(threadId, emitter);
}

export function unregisterTurnEmitter(threadId: string): void {
  turnEmitters.delete(threadId);
}

function needsApproval(risk: RiskLevel, toolName: string): boolean {
  if (GUI_TOOLS.has(toolName)) return true;
  if (isSystemTool(toolName)) return false;
  return risk === "write" || risk === "exec" || risk === "external";
}

function previewArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
  } catch {
    return String(args);
  }
}

function previewContent(content: unknown): string {
  if (typeof content === "string") return content.length > 300 ? content.slice(0, 300) + "…" : content;
  if (Array.isArray(content)) {
    const text = content
      .filter((b) => (b as any)?.type === "text")
      .map((b) => (b as any).text)
      .join(" ");
    return text.length > 300 ? text.slice(0, 300) + "…" : text || "[non-text result]";
  }
  return "[result]";
}

export function createApprovalMiddleware(
  getAlwaysAllow: () => Set<string>,
  onAlwaysAllow: (toolName: string) => void,
) {
  return createMiddleware({
    name: "deepwork_approval",
    wrapToolCall: async (request: any, handler: any) => {
      const toolCall = request.toolCall as { id: string; name: string; args: unknown };
      const threadId: string | undefined = request.config?.configurable?.thread_id;
      const emitter = threadId ? turnEmitters.get(threadId) : undefined;
      const risk = riskOf(toolCall.name);
      const argsPreview = previewArgs(toolCall.args);

      const emit = (e: DeepWorkEvent) => emitter?.emit("event", e);
      emit({ type: "tool_call_started", id: toolCall.id, name: toolCall.name, argsPreview });

      let decision: ApprovalDecision = "allow";
      const alwaysAllowed = getAlwaysAllow();
      const mustAsk =
        needsApproval(risk, toolCall.name) &&
        (GUI_TOOLS.has(toolCall.name) || !alwaysAllowed.has(toolCall.name));
      if (mustAsk) {
        emit({ type: "approval_requested", id: toolCall.id, name: toolCall.name, risk, argsPreview });
        // GUI tools can never be "always allowed" — coerce that choice to "allow".
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
        const outputPreview = ToolMessage.isInstance(result) ? previewContent(result.content) : "[done]";
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
