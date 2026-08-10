import type { Attachment, TurnStats } from "../../../shared/types";
import type { ChatState } from "../state/chatState";

export interface ToolCardData {
  id: string;
  name: string;
  argsPreview: string;
  outputPreview?: string;
  isError?: boolean;
  status: "running" | "done";
  durationMs?: number;
}

export interface ActivityEntry {
  tool?: ToolCardData;
  text?: string;
  live?: boolean;
  key?: string;
}

export type Segment =
  | {
      id: string;
      kind: "msg";
      role: "user" | "assistant";
      content: string;
      attachments?: Attachment[];
      stats?: TurnStats;
    }
  | {
      id: string;
      kind: "activity";
      variant: "command" | "thinking";
      entries: ActivityEntry[];
      isLast: boolean;
    };

export const HIDDEN_TOOLS = new Set(["write_todos", "Task"]);

const ACTION_MARKERS = new Set([
  "create",
  "run",
  "plan",
  "search",
  "analyze",
  "browse",
  "execute",
  "fetch",
  "read",
  "write",
  "call",
  "invoke",
  "next",
  "continue",
  "子",
  "规划",
  "搜索",
  "分析",
  "浏览",
  "执行",
  "调用",
  "创建",
  "开始",
  "下一步",
  "继续",
]);

function isActionMarker(content: string): boolean {
  const t = content.trim().toLowerCase();
  if (t.length === 0) return true;
  if (/[。！？.?!]/.test(t)) return false;
  return ACTION_MARKERS.has(t);
}

export function buildSegments(chat: ChatState): Segment[] {
  const tailIndices: number[] = [];
  const segments: Segment[] = [];
  let bufferVariant: "command" | "thinking" | null = null;
  let buffer: ActivityEntry[] = [];
  const flush = (): void => {
    if (buffer.length && bufferVariant) {
      tailIndices.push(segments.length);
      segments.push({
        id: `a-${buffer[0]?.key ?? segments.length}`,
        kind: "activity",
        variant: bufferVariant,
        entries: buffer,
        isLast: false,
      });
      buffer = [];
      bufferVariant = null;
    }
  };
  const pushActivity = (variant: "command" | "thinking", entry: ActivityEntry): void => {
    if (bufferVariant !== variant) {
      flush();
      bufferVariant = variant;
    }
    buffer.push(entry);
  };
  let lastAssistantIndex = -1;
  for (let i = 0; i < chat.timeline.length; i++) {
    const item = chat.timeline[i];
    if (item.kind === "msg" && item.role === "assistant") lastAssistantIndex = i;
  }
  for (let i = 0; i < chat.timeline.length; i++) {
    const item = chat.timeline[i];
    if (item.kind === "msg") {
      const nextKind = chat.timeline[i + 1]?.kind;
      const suppressed =
        i !== lastAssistantIndex &&
        item.role === "assistant" &&
        isActionMarker(item.content) &&
        (nextKind === "tool" || nextKind === "reasoning" || item.content.trim().length === 0);
      if (suppressed) continue;
      flush();
      segments.push({
        id: `m-${i}`,
        kind: "msg",
        role: item.role,
        content: item.content,
        attachments: item.attachments,
        stats: item.stats,
      });
    } else if (item.kind === "reasoning") {
      pushActivity("thinking", { text: item.text, key: `r${i}` });
    } else {
      const t = chat.tools[item.id];
      if (!t || HIDDEN_TOOLS.has(t.name)) continue;
      pushActivity("command", { tool: t, key: `t${item.id}` });
    }
  }
  flush();
  if (tailIndices.length) {
    const last = segments[tailIndices[tailIndices.length - 1]];
    if (last && last.kind === "activity") last.isLast = true;
  }
  if (chat.streaming) {
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (seg.kind === "activity" && seg.variant === "thinking" && seg.isLast) {
        const last = seg.entries[seg.entries.length - 1];
        if (last) last.live = true;
        break;
      }
    }
  }
  return segments;
}
