import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  ArtifactFile,
  DeepWorkEvent,
  InteractivePermissionMode,
  Session,
  Settings as AppSettings,
  SettingsTab,
  TodoItem,
  UpdateStatus,
} from "../../shared/types";
import { chatReducer, initialChatState } from "./state/chatState";
export type { ChatState, TimelineEntry } from "./state/chatState";
import { Sidebar, type ViewKey } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Settings } from "./components/Settings";
import { Onboarding } from "./components/Onboarding";
import { RightPanel } from "./components/RightPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { TerminalErrorBoundary } from "./components/TerminalErrorBoundary";
import { fileToAttachment } from "./lib/attachments";
import { applyAppearance, watchSystemTheme } from "./lib/theme";
import { useTurnWatchdog } from "./lib/useTurnWatchdog";
import { useChatEvents } from "./hooks/useChatEvents";
import i18n from "./i18n";

export function App(): React.ReactElement {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // A session not in the sidebar list (e.g. an automation-run transcript
  // opened from run history). Resolved on demand so title/model/cwd work even
  // though it's hidden from `sessions`.
  const [extraSession, setExtraSession] = useState<Session | null>(null);
  const [chat, dispatch] = useReducer(chatReducer, initialChatState);
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

  // Keep a ref to the latest settings so the OS-theme watcher (registered once
  // on mount) always re-applies the *current* appearance instead of the stale
  // copy captured when the effect first ran (when `settings` was still null).
  const settingsRef = useRef<AppSettings | null>(null);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    void (async () => {
      await Promise.all([refreshSessions(), refreshSettings()]);
    })();
    const off = window.deepwork.updates.onStatus(setUpdateStatus);
    const offTheme = watchSystemTheme(() => {
      if (settingsRef.current) applyAppearance(settingsRef.current);
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

  const selectedSession =
    sessions.find((s) => s.id === sessionId) ??
    (extraSession?.id === sessionId ? extraSession : undefined);
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

  // Liveness watchdog: if a streaming turn goes silent (no event at all) for
  // the window, the agent or IPC channel is wedged. Reset streaming and show an
  // error so the user isn't permanently locked out of sending (H fix). Each
  // incoming chat event below pokes the timer.
  const pokeWatchdog = useTurnWatchdog(chat.streaming, () => {
    if (sessionIdRef.current) {
      // Tell the main process to abandon the turn; it will no-op if already done.
      void window.deepwork.chat.cancel(sessionIdRef.current);
    }
    dispatch({ type: "set_error", message: i18n.t("chat.turnTimeout") });
  });

  // Subscribe to ALL chat events once, on mount. We filter to the active
  // session inside the callback using the ref. This is race-free for new
  // sessions because the listener already exists before chat.send is called.
  useChatEvents({ sessionIdRef, dispatch, poke: pokeWatchdog, refreshSessions, setApproval, setTodos, setArtifacts });

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
    setExtraSession(null);
    setTodos([]);
    setArtifacts([]);
    setApproval(null);
    setRightCollapsed(true);
    setTerminalOpen(false);
    setResizing(false);
    setHighlightArtifact(null);
    setView("chat");
    dispatch({ type: "reset" });
  };

  const selectSession = async (id: string): Promise<void> => {
    setSessionId(id);
    setView("chat");
    setTodos([]);
    dispatch({ type: "reset" });
    // Automation-run transcripts are hidden from the sidebar list; resolve
    // their metadata on demand so title/model/cwd are populated.
    if (!sessions.some((s) => s.id === id)) {
      const fetched = await window.deepwork.sessions.get(id);
      setExtraSession(fetched);
    } else {
      setExtraSession(null);
    }
    const [history, files, status] = await Promise.all([
      window.deepwork.chat.history(id),
      window.deepwork.artifacts.list(id),
      window.deepwork.chat.status(id),
    ]);
    dispatch({ type: "history", timeline: history.timeline });
    dispatch({ type: "event", event: { type: "turn_state", status } });
    setTodos(history.todos ?? []);
    setArtifacts(files);
  };

  const deleteSession = async (id: string): Promise<void> => {
    await window.deepwork.sessions.delete(id);
    if (sessionId === id) {
      setSessionId(null);
      setExtraSession(null);
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
    mode?: InteractivePermissionMode,
  ): Promise<void> => {
    if (!text.trim() && (!attachments || attachments.length === 0)) return;
    try {
      let sid = sessionId;
      if (!sid) {
        const s = await window.deepwork.sessions.create(
          undefined,
          workspaceDir,
          modelId,
          mode,
        );
        await refreshSessions();
        setSessionId(s.id);
        setExtraSession(null);
        // Update the ref synchronously so the onAnyEvent listener already filters
        // for this session by the time chat.send starts emitting.
        sessionIdRef.current = s.id;
        sid = s.id;
      } else if (modelId) {
        // A session's workspace folder is fixed once created; only the model can
        // still be switched mid-session.
        await window.deepwork.sessions.setModel(sid, modelId);
        await refreshSessions();
      }
      const atts = attachments && attachments.length > 0
        ? await Promise.all(attachments.map(fileToAttachment))
        : undefined;
      dispatch({ type: "user", text, attachments: atts });
      await window.deepwork.chat.send(sid, text, atts, workspaceDir, modelId, mode);
      // Guarantee the right panel reflects produced files even if a streamed
      // event was missed during the new-session handoff.
      setArtifacts(await window.deepwork.artifacts.list(sid));
    } catch (err) {
      dispatch({
        type: "set_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const setSessionModel = async (modelId: string): Promise<void> => {
    if (sessionId) {
      await window.deepwork.sessions.setModel(sessionId, modelId);
      await refreshSessions();
    }
  };

  const setSessionPermissionMode = async (
    mode: InteractivePermissionMode,
  ): Promise<void> => {
    if (sessionId) {
      await window.deepwork.sessions.setPermissionMode(sessionId, mode);
      await refreshSessions();
    }
  };

  const cancel = (): void => {
    if (sessionId) void window.deepwork.chat.cancel(sessionId);
  };

  const regenerate = async (): Promise<void> => {
    if (!sessionId) return;
    try {
      dispatch({ type: "reset_to_user" });
      await window.deepwork.chat.regenerate(sessionId);
    } catch (err) {
      dispatch({
        type: "set_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
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
    view === "chat" && sessionId !== null && !rightCollapsed;
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
              sessionMode={selectedSession?.permissionMode}
              workspaceDir={selectedSession?.workspaceDir}
              enabledModels={enabledModels}
              showReasoning={settings?.showReasoning ?? true}
              funMode={settings?.funMode ?? false}
              onSend={send}
              defaultMode={settings?.permissionMode}
              onSetMode={setSessionPermissionMode}
              onCancel={cancel}
              onRegenerate={regenerate}
              onSetModel={setSessionModel}
              onRefreshModels={refreshModels}
              onAddModel={() => {
                setSettingsTab("models");
                setView("settings");
              }}
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
          {terminalOpen && selectedSession ? (
            <TerminalErrorBoundary onClose={toggleTerminal}>
              <TerminalPanel
                sessionId={selectedSession.id}
                cwd={selectedSession.terminalCwd}
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
