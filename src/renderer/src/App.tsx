import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type {
  ArtifactFile,
  DeepWorkEvent,
  HistoryItem,
  Session,
  Settings as AppSettings,
  SettingsTab,
  TodoItem,
  UpdateStatus,
} from "../../shared/types";
import { Sidebar, type ViewKey } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { ApprovalModal } from "./components/ApprovalModal";
import { Settings } from "./components/Settings";
import { Onboarding } from "./components/Onboarding";
import { RightPanel } from "./components/RightPanel";
import { AutomationsView } from "./components/AutomationsView";
import { Connectors } from "./components/Connectors";
import { fileToAttachment } from "./lib/attachments";
import { applyAppearance, watchSystemTheme } from "./lib/theme";

type ToolRecord = {
  id: string;
  name: string;
  argsPreview: string;
  outputPreview?: string;
  isError?: boolean;
  status: "running" | "done";
};

export type TimelineEntry =
  | { kind: "msg"; role: "user" | "assistant"; content: string; reasoning?: string }
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
    case "reasoning_delta": {
      const timeline = [...state.timeline];
      for (let i = timeline.length - 1; i >= 0; i--) {
        const item = timeline[i];
        if (item.kind === "msg" && item.role === "assistant") {
          timeline[i] = { ...item, reasoning: (item.reasoning ?? "") + e.text };
          return { ...state, timeline };
        }
        if (item.kind === "msg" && item.role === "user") break;
      }
      return state;
    }
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
  const [view, setView] = useState<ViewKey>("chat");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactFile[]>([]);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: "idle" });
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(
    () => localStorage.getItem("dw.right.collapsed") === "1",
  );
  const [rightWidth, setRightWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("dw.right.width"));
    return saved && saved >= 240 && saved <= 720 ? saved : 320;
  });
  const [resizing, setResizing] = useState(false);

  const refreshSessions = useCallback(async (): Promise<void> => {
    setSessions(await window.deepwork.sessions.list());
  }, []);

  const refreshSettings = useCallback(async (): Promise<void> => {
    const s = await window.deepwork.settings.get();
    setSettings(s);
    setNeedsOnboarding(!s.onboarded);
    applyAppearance(s);
  }, []);

  useEffect(() => {
    void (async () => {
      await Promise.all([refreshSessions(), refreshSettings()]);
    })();
    const off = window.deepwork.updates.onStatus(setUpdateStatus);
    const offTheme = watchSystemTheme(() => {
      if (settings) applyAppearance(settings);
    });
    void window.deepwork.updates.check();
    return () => {
      off();
      offTheme();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSessions, refreshSettings]);

  // Onboarding only greets genuinely new installs: not yet onboarded AND no
  // existing sessions (so upgraded users aren't forced through it).
  const showOnboarding =
    needsOnboarding && sessions.length === 0 && view === "chat";

  const selectedSession = sessions.find((s) => s.id === sessionId);
  // Models shown in the picker: exactly the enabled, configured models.
  // Empty when none are configured (the picker shows an empty state).
  const enabledModels = useMemo(
    () => (settings?.configuredModels ?? []).filter((m) => m.enabled),
    [settings],
  );

  // Re-read settings from disk so newly added/edited models appear in the
  // picker without restarting. Called when the picker is opened.
  const refreshModels = useCallback(async (): Promise<void> => {
    await refreshSettings();
  }, [refreshSettings]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void newSession();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
        // Server sends the complete current list for this session.
        setArtifacts(event.artifacts);
      }
      dispatch({ type: "event", event });
    });
    return off;
  }, [sessionId, refreshSessions]);

  const refreshArtifacts = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    try {
      setArtifacts(await window.deepwork.artifacts.list(sessionId));
    } catch {
      // ignore
    }
  }, [sessionId]);

  // When returning to chat from settings/connectors, reload settings so newly
  // added models and appearance changes show up immediately.
  useEffect(() => {
    if (view === "chat") void refreshSettings();
  }, [view, refreshSettings]);

  // Persist right-panel state.
  useEffect(() => {
    localStorage.setItem("dw.right.collapsed", rightCollapsed ? "1" : "0");
  }, [rightCollapsed]);
  useEffect(() => {
    localStorage.setItem("dw.right.width", String(rightWidth));
  }, [rightWidth]);

  // Drag-to-resize the right panel.
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const w = window.innerWidth - e.clientX;
      setRightWidth(Math.min(720, Math.max(240, Math.round(w))));
    };
    const onUp = () => setResizing(false);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizing]);

  // "New task" opens a blank composer without creating a session. The
  // session is only persisted when the user sends the first message
  // (see `send`, which calls sessions.create when there is no id yet).
  const newSession = (): void => {
    setSessionId(null);
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
    const [{ timeline }, files] = await Promise.all([
      window.deepwork.chat.history(id),
      window.deepwork.artifacts.list(id),
    ]);
    dispatch({ type: "history", timeline });
    setArtifacts(files);
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

  const send = async (
    text: string,
    attachments?: File[],
    workspaceDir?: string,
    modelId?: string,
  ): Promise<void> => {
    if (!text.trim() && (!attachments || attachments.length === 0)) return;
    let sid = sessionId;
    if (!sid) {
      const s = await window.deepwork.sessions.create(
        undefined,
        workspaceDir,
        modelId,
      );
      await refreshSessions();
      setSessionId(s.id);
      sid = s.id;
    } else if (workspaceDir || modelId) {
      if (workspaceDir) await window.deepwork.sessions.setWorkspace(sid, workspaceDir);
      if (modelId) await window.deepwork.sessions.setModel(sid, modelId);
      await refreshSessions();
    }
    dispatch({ type: "user", text });
    const atts = attachments && attachments.length > 0
      ? await Promise.all(attachments.map(fileToAttachment))
      : undefined;
    await window.deepwork.chat.send(sid, text, atts, workspaceDir, modelId);
    // Guarantee the right panel reflects produced files even if a streamed
    // event was missed during the new-session handoff.
    setArtifacts(await window.deepwork.artifacts.list(sid));
  };

  const setSessionModel = async (modelId: string): Promise<void> => {
    if (sessionId) {
      await window.deepwork.sessions.setModel(sessionId, modelId);
      await refreshSessions();
    }
  };

  const cancel = (): void => {
    if (sessionId) void window.deepwork.chat.cancel(sessionId);
  };

  const regenerate = async (): Promise<void> => {
    if (!sessionId) return;
    dispatch({ type: "reset_to_user" });
    await window.deepwork.chat.regenerate(sessionId);
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

  const moveToGroup = async (id: string, group: string): Promise<void> => {
    await window.deepwork.sessions.setGroup(id, group);
    await refreshSessions();
  };

  const renameGroup = async (oldName: string, newName: string): Promise<void> => {
    await window.deepwork.sessions.renameGroup(oldName, newName);
    await refreshSessions();
  };

  const deleteGroup = async (name: string): Promise<void> => {
    await window.deepwork.sessions.deleteGroup(name);
    await refreshSessions();
  };

  const createGroup = async (name: string): Promise<void> => {
    await window.deepwork.sessions.createGroup(name);
    await refreshSessions();
  };

  if (showOnboarding && settings) {
    return <Onboarding settings={settings} onDone={finishOnboarding} />;
  }

  const showRight = view === "chat" && !rightCollapsed;

  return (
    <div
      className={`app ${showRight ? "has-right-panel" : ""} ${resizing ? "resizing" : ""}`}
      style={
        showRight
          ? ({ ["--rp-width" as string]: `${rightWidth}px` } as React.CSSProperties)
          : undefined
      }
    >
      <Sidebar
        sessions={sessions}
        activeId={sessionId}
        activeView={view}
        onNew={newSession}
        onSelect={selectSession}
        onDelete={deleteSession}
        onRename={renameSessionById}
        onOpenView={setView}
        onMoveToGroup={moveToGroup}
        onRenameGroup={renameGroup}
        onDeleteGroup={deleteGroup}
        onCreateGroup={createGroup}
      />
      <main className="main">
        {view === "settings" ? (
          <Settings
            onClose={() => setView("chat")}
            updateStatus={updateStatus}
            initialTab={settingsTab}
          />
        ) : view === "connectors" ? (
          <Connectors onClose={() => setView("chat")} />
        ) : view === "automations" ? (
          <AutomationsView onClose={() => setView("chat")} />
        ) : (
          <Chat
            sessionId={sessionId}
            chat={chat}
            todos={todos}
            updateStatus={updateStatus}
            sessionModel={selectedSession?.model}
            enabledModels={enabledModels}
            showReasoning={settings?.showReasoning ?? true}
            onSend={send}
            onCancel={cancel}
            onRegenerate={regenerate}
            onSetModel={setSessionModel}
            onRefreshModels={refreshModels}
            onAddModel={() => {
              setSettingsTab("models");
              setView("settings");
            }}
            onNewSession={newSession}
            onInstallUpdate={() => window.deepwork.updates.install()}
          />
        )}
      </main>
      {showRight && (
        <div className="right-panel-wrap">
          <div
            className={`rp-resizer ${resizing ? "active" : ""}`}
            onMouseDown={() => setResizing(true)}
          />
          <RightPanel
            sessionId={sessionId}
            todos={todos}
            artifacts={artifacts}
            onRefreshArtifacts={refreshArtifacts}
            onClose={() => setRightCollapsed(true)}
          />
        </div>
      )}
      {!showRight && view === "chat" && (
        <button
          className="rp-expand"
          onClick={() => setRightCollapsed(false)}
          title="展开右栏"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/></svg>
        </button>
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
