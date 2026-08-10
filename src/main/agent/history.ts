import type { HistoryItem, TodoItem } from "../../shared/types";

export interface CheckpointMessage {
  content?: unknown;
  tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>;
  tool_call_id?: string;
  additional_kwargs?: Record<string, unknown>;
  _getType?: () => string;
  getType?: () => string;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (block?.type === "text" && typeof block.text === "string") return block.text;
    if (block?.type === "image_url") return "[image]";
    return block?.type === "document" ? "[document]" : "";
  }).filter(Boolean).join("");
}

function preview(value: unknown): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 300 ? text.slice(0, 300) + "…" : text;
  } catch { return String(value); }
}

function todos(value: unknown): TodoItem[] | null {
  try {
    const raw = typeof value === "string" ? JSON.parse(value) : value;
    const list = (raw as { todos?: unknown[] })?.todos;
    if (!Array.isArray(list)) return null;
    return list.map((entry) => {
      const item = entry as { content?: unknown; status?: unknown };
      const content = String(item.content ?? "").trim();
      const status = item.status === "in_progress" || item.status === "completed" ? item.status : "pending";
      return content ? { content, status } : null;
    }).filter((item): item is TodoItem => item !== null);
  } catch { return null; }
}

export function projectHistory(messages: CheckpointMessage[], reasoningOf: (message: CheckpointMessage) => string): { timeline: HistoryItem[]; todos: TodoItem[] } {
  const timeline: HistoryItem[] = [];
  const results = new Map<string, string>();
  let latestTodos: TodoItem[] = [];
  for (const message of messages) {
    const role = message._getType?.() ?? message.getType?.();
    if (role === "human") {
      const content = contentText(message.content);
      if (content) timeline.push({ kind: "msg", role: "user", content });
    } else if (role === "ai" || role === "AIMessageChunk") {
      const reasoning = reasoningOf(message);
      if (reasoning) timeline.push({ kind: "reasoning", text: reasoning.slice(0, 8000), phase: message.tool_calls?.length ? "tool" : "final" });
      const content = contentText(message.content);
      if (content) timeline.push({ kind: "msg", role: "assistant", content });
      for (const call of message.tool_calls ?? []) {
        if (!call.id) continue;
        if (call.name === "write_todos") latestTodos = todos(call.args) ?? latestTodos;
        timeline.push({ kind: "tool", id: call.id, name: call.name, argsPreview: preview(call.args), status: "done", outputPreview: results.get(call.id) });
      }
    } else if (role === "tool" && message.tool_call_id) results.set(message.tool_call_id, preview(message.content));
  }
  for (const item of timeline) if (item.kind === "tool" && item.id && !item.outputPreview) item.outputPreview = results.get(item.id);
  return { timeline, todos: latestTodos };
}
