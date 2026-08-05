import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  ArtifactFile,
  DeepWorkEvent,
  HistoryItem,
  Session,
  Settings as AppSettings,
  SettingsTab,
  TodoItem,
  TurnStats,
  UpdateStatus,
} from "../../shared/types";
import { Sidebar, type ViewKey } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Settings } from "./components/Settings";
import { Onboarding } from "./components/Onboarding";
import { RightPanel } from "./components/RightPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { TerminalErrorBoundary } from "./components/TerminalErrorBoundary";
import { AutomationsView } from "./components/AutomationsView";
import { Connectors } from "./components/Connectors";
import { fileToAttachment } from "./lib/attachments";
import { applyAppearance, watchSystemTheme } from "./lib/theme";
import i18n from "./i18n";

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
  | { kind: "msg"; role: "user" | "assistant"; content: string; stats?: TurnStats }
  | { kind: "reasoning"; text: string; phase?: "tool" | "final" }
  | { kind: "tool"; id: string };

export type ChatState = {
  timeline: TimelineEntry[];
  tools: Record<string, ToolRecord>;
  /** Wall-clock time each tool call started, used to compute tool latency. */
  toolStart: Record<string, number>;
  streaming: boolean;
  error?: string;
};

const initialChat: ChatState = { timeline: [], tools: {}, toolStart: {}, streaming: false };

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
        // Legacy history stored reasoning on the assistant message itself.
        // Render it as a preceding reasoning block for chronological parity.
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
    case "reasoning_phase_started": {
      return {
        ...state,
        timeline: [...state.timeline, { kind: "reasoning", text: "", phase: "tool" }],
      };
    }
    case "reasoning_delta": {
      const timeline = [...state.timeline];
      for (let i = timeline.length - 1; i >= 0; i--) {
        const item = timeline[i];
        if (item.kind === "reasoning") {
          timeline[i] = { ...item, text: item.text + e.text };
          return { ...state, timeline };
        }
      }
      return state;
    }
    case "reasoning_phase_finished": {
      const timeline = [...state.timeline];
      for (let i = timeline.length - 1; i >= 0; i--) {
        const item = timeline[i];
        if (item.kind === "reasoning") {
          if (!item.text) {
            // Non-reasoning models can open an empty phase; drop it.
            timeline.splice(i, 1);
          } else {
            timeline[i] = { ...item, phase: e.phase };
          }
          return { ...state, timeline };
        }
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
      return { ...state, tools, timeline, toolStart: { ...state.toolStart, [e.id]: Date.now() } };
    }
    case "tool_call_finished": {
      const existing = state.tools[e.id];
      const startedAt = state.toolStart[e.id];
      const durationMs = startedAt ? Date.now() - startedAt : undefined;
      const tools = {
        ...state.tools,
        [e.id]: {
          id: e.id,
          name: e.name,
          argsPreview: existing?.argsPreview ?? "",
          outputPreview: e.outputPreview,
          isError: e.isError,
          status: "done" as const,
          ...(durationMs !== undefined ? { durationMs } : {}),
        },
      };
      return { ...state, tools };
    }
    case "turn_stats": {
      // Attach telemetry to the most recent assistant message in the timeline.
      const timeline = [...state.timeline];
      for (let i = timeline.length - 1; i >= 0; i--) {
        const item = timeline[i];
        if (item.kind === "msg" && item.role === "assistant") {
          timeline[i] = { ...item, stats: e };
          break;
        }
      }
      return { ...state, timeline };
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
  // A produced-artifact the user jumped to from the chat: opens the right panel
  // and briefly highlights the matching entry. `n` re-triggers for repeats.
  const [highlightArtifact, setHighlightArtifact] = useState<{ path: string; n: number } | null>(null);
  // Terminal panel toggle (lives inside the right panel as its own section).
  const [terminalOpen, setTerminalOpen] = useState(false);
  const toggleTerminal = useCallback((): void => {
    setRightCollapsed(false);
    setTerminalOpen((v) => !v);
  }, []);

  // The right region shows one of two full-area views: the terminal, or the
  // panel (todos + artifacts). The fold button switches terminal -> panel, and
  // toggles the whole region when already on the panel.
  const toggleRightPanel = useCallback((): void => {
    if (terminalOpen) {
      setTerminalOpen(false);
      setRightCollapsed(false);
    } else {
      setRightCollapsed((v) => !v);
    }
  }, [terminalOpen]);

  const refreshSessions = useCallback(async (): Promise<void> => {
    setSessions(await window.deepwork.sessions.list());
  }, []);

  const refreshSettings = useCallback(async (): Promise<void> => {
    const s = await window.deepwork.settings.get();
    setSettings(s);
    setNeedsOnboarding(!s.onboarded);
    applyAppearance(s);
    void i18n.changeLanguage(s.language);
  }, []);

  // Apply the selected interface language to i18n as soon as it changes.
  useEffect(() => {
    if (settings?.language) void i18n.changeLanguage(settings.language);
  }, [settings?.language]);

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

  // Keep a ref to the active sessionId so the single event subscription below
  // always filters against the latest value without needing to resubscribe.
  // Resubscribing per session created a race where a brand-new session's first
  // events could fire before the new listener was attached.
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Subscribe to ALL chat events once, on mount. We filter to the active
  // session inside the callback using the ref. This is race-free for new
  // sessions because the listener already exists before chat.send is called.
  useEffect(() => {
    return window.deepwork.chat.onAnyEvent((sid, event) => {
      if (sid !== sessionIdRef.current) return;
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
  }, [refreshSessions]);

  const refreshArtifacts = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    try {
      setArtifacts(await window.deepwork.artifacts.list(sessionId));
    } catch {
      // ignore
    }
  }, [sessionId]);

  // Open the right panel (if collapsed) and flash-highlight a produced artifact.
  const jumpToArtifact = useCallback((path: string): void => {
    setRightCollapsed(false);
    setHighlightArtifact({ path, n: Date.now() });
  }, []);

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
    const [history, files] = await Promise.all([
      window.deepwork.chat.history(id),
      window.deepwork.artifacts.list(id),
    ]);
    dispatch({ type: "history", timeline: history.timeline });
    setTodos(history.todos ?? []);
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
      // Update the ref synchronously so the onAnyEvent listener already filters
      // for this session by the time chat.send starts emitting.
      sessionIdRef.current = s.id;
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

  const showRight =
    view === "chat" && !rightCollapsed && (!!sessionId || terminalOpen);
  // Narrow the pending approval event for the inline banner (null when none/other type).
  const approvalRequest =
    approval && approval.type === "approval_requested" ? approval : null;

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
            onSaved={() => void refreshSettings()}
          />
        ) : view === "connectors" ? (
          <Connectors onClose={() => setView("chat")} />
        ) : view === "automations" ? (
          <AutomationsView onClose={() => setView("chat")} />
        ) : (
          <>
            <Chat
              sessionId={sessionId}
              sessionTitle={selectedSession?.title}
              chat={chat}
              todos={todos}
              artifacts={artifacts}
              updateStatus={updateStatus}
              sessionModel={selectedSession?.model}
              enabledModels={enabledModels}
              showReasoning={settings?.showReasoning ?? true}
              funMode={settings?.funMode ?? false}
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
              rightPanelOpen={showRight}
              onToggleRightPanel={toggleRightPanel}
              terminalOpen={terminalOpen}
              onToggleTerminal={toggleTerminal}
              approval={approvalRequest}
              onRespondApproval={respondApproval}
              onJumpToArtifact={jumpToArtifact}
            />
          </>
        )}
      </main>
      {showRight && (
        <div className="right-panel-wrap">
          <div
            className={`rp-resizer ${resizing ? "active" : ""}`}
            onMouseDown={() => setResizing(true)}
          />
          {terminalOpen ? (
            <TerminalErrorBoundary onClose={toggleTerminal}>
              <TerminalPanel
                cwd={selectedSession?.rootDir}
                onClose={toggleTerminal}
              />
            </TerminalErrorBoundary>
          ) : (
            <RightPanel
              sessionId={sessionId}
              todos={todos}
              artifacts={artifacts}
              onRefreshArtifacts={refreshArtifacts}
              onClose={() => setRightCollapsed(true)}
              highlightArtifact={highlightArtifact}
            />
          )}
        </div>
      )}
    </div>
  );
}
