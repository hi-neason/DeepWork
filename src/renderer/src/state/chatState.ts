import type { Attachment, DeepWorkEvent, HistoryItem, TurnStats } from "../../../shared/types";

type ToolRecord = {
  id: string;
  name: string;
  argsPreview: string;
  outputPreview?: string;
  isError?: boolean;
  status: "running" | "done";
  durationMs?: number;
};

export type TimelineEntry =
  | { kind: "msg"; role: "user" | "assistant"; content: string; attachments?: Attachment[]; stats?: TurnStats }
  | { kind: "reasoning"; text: string; phase?: "tool" | "final" }
  | { kind: "tool"; id: string };

export type ChatState = {
  timeline: TimelineEntry[];
  tools: Record<string, ToolRecord>;
  toolStart: Record<string, number>;
  streaming: boolean;
  error?: string;
};

export const initialChatState: ChatState = {
  timeline: [],
  tools: {},
  toolStart: {},
  streaming: false,
};

export type ChatAction =
  | { type: "user"; text: string; attachments?: Attachment[] }
  | { type: "event"; event: DeepWorkEvent }
  | { type: "history"; timeline: HistoryItem[] }
  | { type: "reset_to_user" }
  | { type: "reset" }
  | { type: "set_error"; message: string };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === "reset") return { ...initialChatState };
  if (action.type === "reset_to_user") {
    const timeline = [...state.timeline];
    while (timeline.length > 0) {
      const last = timeline[timeline.length - 1];
      if (last.kind === "msg" && last.role === "user") break;
      timeline.pop();
    }
    return { ...state, timeline, tools: {}, streaming: true, error: undefined };
  }
  if (action.type === "history") {
    const timeline: TimelineEntry[] = [];
    const tools: Record<string, ToolRecord> = {};
    for (const item of action.timeline) {
      if (item.kind === "msg" && item.role && item.content) {
        if (item.role === "assistant" && item.reasoning) {
          timeline.push({ kind: "reasoning", text: item.reasoning, phase: "final" });
        }
        timeline.push({ kind: "msg", role: item.role, content: item.content, stats: item.stats });
      } else if (item.kind === "reasoning" && item.text) {
        timeline.push({ kind: "reasoning", text: item.text, phase: item.phase ?? "final" });
      } else if (item.kind === "tool" && item.id) {
        timeline.push({ kind: "tool", id: item.id });
        if (item.name) {
          tools[item.id] = {
            id: item.id,
            name: item.name,
            argsPreview: item.argsPreview ?? "",
            outputPreview: item.outputPreview,
            isError: item.isError,
            status: item.status ?? "done",
          };
        }
      }
    }
    return { timeline, tools, toolStart: {}, streaming: false };
  }
  if (action.type === "user") {
    const userEntry: TimelineEntry = {
      kind: "msg",
      role: "user",
      content: action.text,
      ...(action.attachments && action.attachments.length > 0 ? { attachments: action.attachments } : {}),
    };
    return {
      ...state,
      timeline: [...state.timeline, userEntry],
      streaming: true,
      error: undefined,
    };
  }
  if (action.type === "set_error") return { ...state, streaming: false, error: action.message };

  const event = action.event;
  switch (event.type) {
    case "turn_state":
      return {
        ...state,
        streaming: ["running", "waiting_approval", "cancelling"].includes(event.status.state),
      };
    case "message_delta": {
      const timeline = [...state.timeline];
      for (let index = timeline.length - 1; index >= 0; index--) {
        const item = timeline[index];
        if (item.kind === "msg" && item.role === "assistant") {
          timeline[index] = { ...item, content: item.content + event.text };
          return { ...state, timeline };
        }
        if (item.kind === "msg" && item.role === "user") break;
      }
      timeline.push({ kind: "msg", role: "assistant", content: event.text });
      return { ...state, timeline };
    }
    case "reasoning_phase_started":
      return { ...state, timeline: [...state.timeline, { kind: "reasoning", text: "", phase: "tool" }] };
    case "reasoning_delta": {
      const timeline = [...state.timeline];
      for (let index = timeline.length - 1; index >= 0; index--) {
        const item = timeline[index];
        if (item.kind === "reasoning") {
          timeline[index] = { ...item, text: item.text + event.text };
          return { ...state, timeline };
        }
      }
      return state;
    }
    case "reasoning_phase_finished": {
      const timeline = [...state.timeline];
      for (let index = timeline.length - 1; index >= 0; index--) {
        const item = timeline[index];
        if (item.kind === "reasoning") {
          if (!item.text) timeline.splice(index, 1);
          else timeline[index] = { ...item, phase: event.phase };
          return { ...state, timeline };
        }
      }
      return state;
    }
    case "tool_call_started": {
      const tools = { ...state.tools, [event.id]: { id: event.id, name: event.name, argsPreview: event.argsPreview, status: "running" as const } };
      const timeline = state.tools[event.id] ? state.timeline : [...state.timeline, { kind: "tool" as const, id: event.id }];
      return { ...state, tools, timeline, toolStart: { ...state.toolStart, [event.id]: Date.now() } };
    }
    case "tool_call_finished": {
      const existing = state.tools[event.id];
      const startedAt = state.toolStart[event.id];
      const durationMs = startedAt ? Date.now() - startedAt : undefined;
      return {
        ...state,
        tools: {
          ...state.tools,
          [event.id]: { id: event.id, name: event.name, argsPreview: existing?.argsPreview ?? "", outputPreview: event.outputPreview, isError: event.isError, status: "done", ...(durationMs !== undefined ? { durationMs } : {}) },
        },
      };
    }
    case "turn_stats": {
      const timeline = [...state.timeline];
      for (let index = timeline.length - 1; index >= 0; index--) {
        const item = timeline[index];
        if (item.kind === "msg" && item.role === "assistant") {
          timeline[index] = { ...item, stats: event };
          break;
        }
      }
      return { ...state, timeline };
    }
    case "turn_completed":
    case "turn_aborted":
      return { ...state, streaming: false };
    case "turn_error":
      return { ...state, streaming: false, error: event.message };
    default:
      return state;
  }
}
