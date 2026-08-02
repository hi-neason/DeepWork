import { useEffect, useReducer, useState } from "react";
import type {
  ApprovalMode,
  DeepWorkEvent,
  HistoryItem,
  Session,
  Settings as AppSettings,
} from "../../shared/types";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { ApprovalModal } from "./components/ApprovalModal";
import { Settings } from "./components/Settings";

type ToolRecord = {
  id: string;
  name: string;
  argsPreview: string;
  outputPreview?: string;
  isError?: boolean;
  status: "running" | "done";
};

export type TimelineEntry =
  | { kind: "msg"; role: "user" | "assistant"; content: string }
  | { kind: "tool"; id: string };

export type ChatState = {
  timeline: TimelineEntry[];
  tools: Record<string, ToolRecord>;
  streaming: boolean;
  error?: string;
};

const initialChat: ChatState = { timeline: [], tools: {}, streaming: false };

type Action =
  | { type: "user"; text: string }
  | { type: "event"; event: DeepWorkEvent }
  | { type: "history"; timeline: HistoryItem[] }
  | { type: "reset_to_user" }
  | { type: "reset" };

function reducer(state: ChatState, action: Action): ChatState {
  if (action.type === "reset") return { ...initialChat };
  if (action.type === "reset_to_user") {
    // Drop trailing assistant/tool items so a regenerate can re-stream them.
    const timeline = [...state.timeline];
    while (
      timeline.length > 0 &&
      !(timeline[timeline.length - 1].kind === "msg" &&
        (timeline[timeline.length - 1] as any).role === "user")
    ) {
      timeline.pop();
    }
    return { ...state, timeline, tools: {}, streaming: true, error: undefined };
  }
  if (action.type === "history") {
    const timeline: TimelineEntry[] = [];
    const tools: Record<string, ToolRecord> = {};
    for (const item of action.timeline) {
      if (item.kind === "msg" && item.role && item.content) {
        timeline.push({ kind: "msg", role: item.role, content: item.content });
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
    return { timeline, tools, streaming: false };
  }
  if (action.type === "user") {
    return {
      ...state,
      timeline: [...state.timeline, { kind: "msg", role: "user", content: action.text }],
      streaming: true,
      error: undefined,
    };
  }
  const e = action.event;
  switch (e.type) {
    case "message_delta": {
      const timeline = [...state.timeline];
      // Append to the trailing assistant message if present, otherwise add one.
      for (let i = timeline.length - 1; i >= 0; i--) {
        const item = timeline[i];
        if (item.kind === "msg" && item.role === "assistant") {
          timeline[i] = { ...item, content: item.content + e.text };
          return { ...state, timeline };
        }
        if (item.kind === "msg" && item.role === "user") break;
      }
      timeline.push({ kind: "msg", role: "assistant", content: e.text });
      return { ...state, timeline };
    }
    case "reasoning_delta":
      return state;
    case "tool_call_started": {
      const tools = {
        ...state.tools,
        [e.id]: { id: e.id, name: e.name, argsPreview: e.argsPreview, status: "running" as const },
      };
      const timeline = state.tools[e.id]
        ? state.timeline
        : [...state.timeline, { kind: "tool" as const, id: e.id }];
      return { ...state, tools, timeline };
    }
    case "tool_call_finished": {
      const existing = state.tools[e.id];
      const tools = {
        ...state.tools,
        [e.id]: {
          id: e.id,
          name: e.name,
          argsPreview: existing?.argsPreview ?? "",
          outputPreview: e.outputPreview,
          isError: e.isError,
          status: "done" as const,
        },
      };
      return { ...state, tools };
    }
    case "turn_completed":
      return { ...state, streaming: false };
    case "turn_error":
      return { ...state, streaming: false, error: e.message };
    default:
      return state;
  }
}

export function App(): React.ReactElement {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [chat, dispatch] = useReducer(reducer, initialChat);
  const [approval, setApproval] = useState<DeepWorkEvent | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  const refreshSessions = async (): Promise<void> => {
    setSessions(await window.deepwork.sessions.list());
  };

  const refreshSettings = async (): Promise<void> => {
    setSettings(await window.deepwork.settings.get());
  };

  useEffect(() => {
    void refreshSessions();
    void refreshSettings();
  }, []);

  // Subscribe to agent events for the active session.
  useEffect(() => {
    if (!sessionId) return;
    const off = window.deepwork.chat.onEvent(sessionId, (event) => {
      if (event.type === "approval_requested") {
        setApproval(event);
      }
      if (event.type === "session_renamed") {
        void refreshSessions();
      }
      dispatch({ type: "event", event });
    });
    return off;
  }, [sessionId]);

  const newSession = async (): Promise<void> => {
    const s = await window.deepwork.sessions.create();
    await refreshSessions();
    setSessionId(s.id);
    dispatch({ type: "reset" });
  };

  const selectSession = async (id: string): Promise<void> => {
    setSessionId(id);
    dispatch({ type: "reset" });
    const { timeline } = await window.deepwork.chat.history(id);
    dispatch({ type: "history", timeline });
  };

  const deleteSession = async (id: string): Promise<void> => {
    await window.deepwork.sessions.delete(id);
    if (sessionId === id) {
      setSessionId(null);
      dispatch({ type: "reset" });
    }
    await refreshSessions();
  };

  const renameSessionById = async (id: string, title: string): Promise<void> => {
    await window.deepwork.sessions.rename(id, title);
    await refreshSessions();
  };

  const send = async (text: string): Promise<void> => {
    if (!text.trim()) return;
    let sid = sessionId;
    if (!sid) {
      const s = await window.deepwork.sessions.create();
      await refreshSessions();
      setSessionId(s.id);
      sid = s.id;
    }
    dispatch({ type: "user", text });
    await window.deepwork.chat.send(sid, text);
  };

  const regenerate = async (): Promise<void> => {
    if (!sessionId) return;
    // Drop the trailing assistant message/tool results from the UI, then re-run.
    dispatch({ type: "reset_to_user" });
    await window.deepwork.chat.regenerate(sessionId);
  };

  const toggleApprovalMode = async (): Promise<void> => {
    if (!settings) return;
    const next: ApprovalMode = settings.approvalMode === "auto" ? "manual" : "auto";
    const updated = { ...settings, approvalMode: next };
    setSettings(updated);
    await window.deepwork.settings.save(updated);
    // Mode is read live by the middleware; no agent rebuild required.
  };

  const respondApproval = async (decision: "allow" | "deny" | "always_allow"): Promise<void> => {
    if (approval && approval.type === "approval_requested") {
      await window.deepwork.approval.respond(approval.id, decision);
    }
    setApproval(null);
  };

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeId={sessionId}
        onNew={newSession}
        onSelect={selectSession}
        onDelete={deleteSession}
        onRename={renameSessionById}
        onOpenSettings={() => setShowSettings(true)}
      />
      <main className="main">
        {showSettings ? (
          <Settings
            onClose={() => {
              setShowSettings(false);
              void refreshSettings();
            }}
          />
        ) : (
          <Chat
            sessionId={sessionId}
            chat={chat}
            mcpServers={settings?.mcpServers ?? []}
            approvalMode={settings?.approvalMode ?? "manual"}
            onSend={send}
            onRegenerate={regenerate}
            onToggleMode={toggleApprovalMode}
            onNewSession={newSession}
          />
        )}
      </main>
      {approval && approval.type === "approval_requested" && (
        <ApprovalModal
          name={approval.name}
          risk={approval.risk}
          argsPreview={approval.argsPreview}
          isGuiTool={["screenshot", "mouse_move", "mouse_click", "keyboard_type", "keyboard_press"].includes(
            approval.name,
          )}
          onAllow={() => respondApproval("allow")}
          onAlwaysAllow={() => respondApproval("always_allow")}
          onDeny={() => respondApproval("deny")}
        />
      )}
    </div>
  );
}
