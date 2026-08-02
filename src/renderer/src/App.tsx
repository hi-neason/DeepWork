import { useCallback, useEffect, useReducer, useState } from "react";
import type {
  ArtifactFile,
  DeepWorkEvent,
  HistoryItem,
  Session,
  Settings as AppSettings,
  TodoItem,
  UpdateStatus,
} from "../../shared/types";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { ApprovalModal } from "./components/ApprovalModal";
import { Settings } from "./components/Settings";
import { Onboarding } from "./components/Onboarding";
import { ArtifactsPanel } from "./components/ArtifactsPanel";
import { AutomationsView } from "./components/AutomationsView";
import { fileToAttachment } from "./lib/attachments";

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
    case "turn_aborted":
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
  const [view, setView] = useState<"chat" | "settings" | "automations">("chat");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactFile[]>([]);
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: "idle" });
  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  const refreshSessions = useCallback(async (): Promise<void> => {
    setSessions(await window.deepwork.sessions.list());
  }, []);

  const refreshSettings = useCallback(async (): Promise<void> => {
    const s = await window.deepwork.settings.get();
    setSettings(s);
    setNeedsOnboarding(!s.onboarded);
  }, []);

  useEffect(() => {
    void (async () => {
      await Promise.all([refreshSessions(), refreshSettings()]);
    })();
    const off = window.deepwork.updates.onStatus(setUpdateStatus);
    void window.deepwork.updates.check();
    return off;
  }, [refreshSessions, refreshSettings]);

  // Onboarding only greets genuinely new installs: not yet onboarded AND no
  // existing sessions (so upgraded users aren't forced through it).
  const showOnboarding =
    needsOnboarding && sessions.length === 0 && view === "chat";

  // Subscribe to agent events for the active session.
  useEffect(() => {
    if (!sessionId) return;
    setTodos([]);
    const off = window.deepwork.chat.onEvent(sessionId, (event) => {
      if (event.type === "approval_requested") {
        setApproval(event);
      }
      if (event.type === "session_renamed") {
        void refreshSessions();
      }
      if (event.type === "todos_updated") {
        setTodos(event.todos);
      }
      if (event.type === "artifacts_updated") {
        setArtifacts((prev) => mergeArtifacts(prev, event.artifacts));
      }
      dispatch({ type: "event", event });
    });
    return off;
  }, [sessionId, refreshSessions]);

  const newSession = async (): Promise<void> => {
    const s = await window.deepwork.sessions.create();
    await refreshSessions();
    setSessionId(s.id);
    setTodos([]);
    setArtifacts([]);
    setView("chat");
    dispatch({ type: "reset" });
  };

  const selectSession = async (id: string): Promise<void> => {
    setSessionId(id);
    setView("chat");
    setTodos([]);
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

  const send = async (text: string, attachments?: File[]): Promise<void> => {
    if (!text.trim() && (!attachments || attachments.length === 0)) return;
    let sid = sessionId;
    if (!sid) {
      const s = await window.deepwork.sessions.create();
      await refreshSessions();
      setSessionId(s.id);
      sid = s.id;
    }
    dispatch({ type: "user", text });
    // Convert File attachments to data-transfer objects the main side can use.
    const atts = attachments && attachments.length > 0
      ? await Promise.all(attachments.map(fileToAttachment))
      : undefined;
    await window.deepwork.chat.send(sid, text, atts);
  };

  const cancel = (): void => {
    if (sessionId) void window.deepwork.chat.cancel(sessionId);
  };

  const regenerate = async (): Promise<void> => {
    if (!sessionId) return;
    dispatch({ type: "reset_to_user" });
    await window.deepwork.chat.regenerate(sessionId);
  };

  const setMode = async (mode: "manual" | "auto" | "plan"): Promise<void> => {
    if (!settings) return;
    const updated = { ...settings, permissionMode: mode };
    setSettings(updated);
    await window.deepwork.settings.save(updated);
  };

  const respondApproval = async (decision: "allow" | "deny" | "always_allow"): Promise<void> => {
    if (approval && approval.type === "approval_requested") {
      await window.deepwork.approval.respond(approval.id, decision);
    }
    setApproval(null);
  };

  const finishOnboarding = async (): Promise<void> => {
    await window.deepwork.settings.setOnboarded(true);
    await refreshSettings();
  };

  if (showOnboarding && settings) {
    return <Onboarding settings={settings} onDone={finishOnboarding} />;
  }

  return (
    <div className={`app${showArtifacts ? " has-artifacts" : ""}`}>
      <Sidebar
        sessions={sessions}
        activeId={sessionId}
        onNew={newSession}
        onSelect={selectSession}
        onDelete={deleteSession}
        onRename={renameSessionById}
        onOpenSettings={() => setView("settings")}
        onOpenAutomations={() => setView("automations")}
      />
      <main className="main">
        {view === "settings" ? (
          <Settings onClose={() => setView("chat")} />
        ) : view === "automations" ? (
          <AutomationsView onClose={() => setView("chat")} />
        ) : (
          <Chat
            sessionId={sessionId}
            chat={chat}
            todos={todos}
            artifactsCount={artifacts.length}
            updateStatus={updateStatus}
            permissionMode={settings?.permissionMode ?? "manual"}
            onSend={send}
            onCancel={cancel}
            onRegenerate={regenerate}
            onSetMode={setMode}
            onNewSession={newSession}
            onToggleArtifacts={() => setShowArtifacts((v) => !v)}
            onInstallUpdate={() => window.deepwork.updates.install()}
          />
        )}
      </main>
      {showArtifacts && (
        <ArtifactsPanel
          artifacts={artifacts}
          onClose={() => setShowArtifacts(false)}
          onRefresh={async () => {
            // Artifacts are pushed at turn end; this is a no-op placeholder.
          }}
        />
      )}
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

function mergeArtifacts(prev: ArtifactFile[], next: ArtifactFile[]): ArtifactFile[] {
  const map = new Map<string, ArtifactFile>();
  for (const a of prev) map.set(a.absolutePath, a);
  for (const a of next) map.set(a.absolutePath, a);
  return Array.from(map.values()).sort((a, b) => b.modifiedAt - a.modifiedAt);
}
