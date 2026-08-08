import { useEffect, useMemo, useRef, useState } from "react";

/** Brand label shown above assistant messages (replaces plain "AI" text). */
function DeepWorkLabel() {
  return (
    <span className="role-deepwork">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L18 3.06l-2.94-2.94a1.21 1.21 0 0 0-1.72 0l-1.28 1.28a1.2 1.2 0 0 0 0 1.72L14.06 6l-9.7 9.7a1 1 0 0 0-.29.71V19a1 1 0 0 0 1 1h2.59a1 1 0 0 0 .71-.29L18 11.36l2.92 2.92a1.2 1.2 0 0 0 1.72 0Z"/>
        <path d="M14 6l-4 4"/>
        <path d="m5 20 4-4"/>
      </svg>
      DeepWork
    </span>
  );
}
import type { ChatState } from "../App";
import type {
  ArtifactFile,
  ConfiguredModel,
  DeepWorkEvent,
  PermissionMode,
  Skill,
  TodoItem,
  TurnStats,
  UpdateStatus,
} from "../../../shared/types";
import { useTranslation, Trans } from "react-i18next";
import { CommitRunner } from "./CommitRunner";
import i18n from "../i18n";
import { Markdown } from "./Markdown";

interface RecentFolder {
  path: string;
  name: string;
}

interface Props {
  sessionId: string | null;
  sessionTitle?: string;
  chat: ChatState;
  todos: TodoItem[];
  artifacts: ArtifactFile[];
  updateStatus: UpdateStatus;
  workspaceDir?: string;
  sessionModel?: string;
  enabledModels: ConfiguredModel[];
  showReasoning?: boolean;
  funMode?: boolean;
  onSend: (
    text: string,
    attachments?: File[],
    workspaceDir?: string,
    modelId?: string,
    mode?: PermissionMode,
  ) => void;
  /** Global default permission mode (from settings) — highlighted when no per-send override is chosen. */
  defaultMode?: PermissionMode;
  onCancel: () => void;
  onRegenerate: () => void;
  onSetModel: (modelId: string) => void;
  onRefreshModels: () => void | Promise<void>;
  onAddModel: () => void;
  onInstallUpdate: () => void;
  rightPanelOpen: boolean;
  onToggleRightPanel: () => void;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  /** A pending approval request rendered inline above the composer (null when none). */
  approval?: Extract<DeepWorkEvent, { type: "approval_requested" }> | null;
  onRespondApproval: (decision: "allow" | "deny" | "always_allow") => void;
  /** Open the right panel and highlight a produced artifact. */
  onJumpToArtifact: (path: string) => void;
}

export function Chat({
  sessionId,
  sessionTitle,
  chat,
  todos,
  artifacts,
  updateStatus,
  workspaceDir,
  sessionModel,
  enabledModels,
  showReasoning = true,
  funMode = false,
  onSend,
  defaultMode,
  onCancel,
  onRegenerate,
  onSetModel,
  onRefreshModels,
  onAddModel,
  onInstallUpdate,
  rightPanelOpen,
  onToggleRightPanel,
  terminalOpen,
  onToggleTerminal,
  approval,
  onRespondApproval,
  onJumpToArtifact,
}: Props): React.ReactElement {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [showFolderMenu, setShowFolderMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [recent, setRecent] = useState<RecentFolder[]>([]);
  // Workspace/model chosen for a brand-new session (before it is created).
  const [pendingWorkspace, setPendingWorkspace] = useState<string | undefined>(undefined);
  const [pendingModel, setPendingModel] = useState<string | undefined>(undefined);
  // Per-send permission-mode override (undefined = follow global default).
  const [pendingMode, setPendingMode] = useState<PermissionMode | undefined>(undefined);
  // Dropdown open state for the permission-mode picker.
  const [showModeMenu, setShowModeMenu] = useState(false);
  const modeWrapRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const segmentRefs = useRef<(HTMLDivElement | null)[]>([]);
  const historyWrapRef = useRef<HTMLDivElement>(null);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const { t } = useTranslation();

  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [showHistory, setShowHistory] = useState(false);

  // Slash command: type "/" at start of input to search/insert skills.
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [skills, setSkills] = useState<Skill[]>([]);

  // Derived: slash-command matches.
  const slashMatches = useMemo(() => {
    if (!slashOpen) return [];
    const q = slashQuery.toLowerCase();
    if (!q) return skills.slice(0, 8);
    return skills
      .filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [slashOpen, slashQuery, skills]);

  const activeModel = sessionModel ?? pendingModel ?? enabledModels[0]?.id;
  // Effective permission mode for this send (pending override → global default).
  const currentMode: PermissionMode = pendingMode ?? defaultMode ?? "auto";
  const activeModelLabel = useMemo(() => {
    if (!activeModel) return t("chat.noModel");
    const m = enabledModels.find((x) => x.id === activeModel);
    return m ? shortLabel(m) : activeModel.split(":").pop();
  }, [activeModel, enabledModels]);

  const activeWorkspace = workspaceDir ?? pendingWorkspace;
  // Once a session exists its workspace folder is locked and cannot be changed.
  const folderLocked = !!sessionId;
  const folderLabel = useMemo(() => {
    if (activeWorkspace) {
      const parts = activeWorkspace.split(/[/\\]/).filter(Boolean);
      return parts[parts.length - 1] || activeWorkspace;
    }
    return folderLocked ? t("chat.defaultWorkspace") : t("chat.chooseFolderOptional");
  }, [activeWorkspace, folderLocked, t]);

  // Load enabled skills for slash command on mount.
  useEffect(() => {
    void window.deepwork.skills.list().then((list) => {
      setSkills(list.filter((s) => s.enabled));
    });
  }, []);

  useEffect(() => {
    void window.deepwork.sessions.recentFolders().then(setRecent);
  }, [sessionId]);

  // A picked folder only applies to a brand-new session; once a session exists
  // its workspace is fixed, so clear the pending pick on session change.
  useEffect(() => {
    setPendingWorkspace(undefined);
  }, [sessionId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat, todos]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [input]);

  // Focus search input when opened; close search with Escape.
  useEffect(() => {
    if (!showSearch) return;
    searchInputRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setShowSearch(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSearch]);

  useEffect(() => {
    if (!showHistory && !showSearch) return;
    const onClick = (e: MouseEvent): void => {
      if (!historyWrapRef.current?.contains(e.target as Node)) {
        setShowHistory(false);
      }
      if (!searchWrapRef.current?.contains(e.target as Node)) {
        setShowSearch(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [showHistory, showSearch]);

  // Close the permission-mode dropdown on outside click.
  useEffect(() => {
    if (!showModeMenu) return;
    const onClick = (e: MouseEvent): void => {
      if (!modeWrapRef.current?.contains(e.target as Node)) {
        setShowModeMenu(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [showModeMenu]);

  const submit = (): void => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || chat.streaming) return;
    setInput("");
    setAttachments([]);
    setSlashOpen(false);
    void onSend(text, attachments, activeWorkspace, activeModel, pendingMode);
    setPendingWorkspace(undefined);
    setPendingModel(undefined);
    setPendingMode(undefined);
  };

  /** Replace "/query" with "/skill-name " and close the slash menu. */
  const selectSlashSkill = (name: string): void => {
    setInput(`/${name} `);
    setSlashOpen(false);
    // Refocus textarea; caret will be at end after the trailing space.
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const chooseModel = (id: string): void => {
    setPendingModel(id);
    setShowModelMenu(false);
    if (sessionId) onSetModel(id);
  };

  const pickFolder = async (): Promise<void> => {
    const dir = await window.deepwork.settings.pickDirectory();
    if (dir) setPendingWorkspace(dir);
    setShowFolderMenu(false);
    void window.deepwork.sessions.recentFolders().then(setRecent);
  };

  const chooseRecent = (p: string): void => {
    setPendingWorkspace(p);
    setShowFolderMenu(false);
  };

  const clearFolder = (): void => {
    setPendingWorkspace(undefined);
    setShowFolderMenu(false);
  };

  const onPickFiles = (files: FileList | null): void => {
    if (!files) return;
    setAttachments((prev) => [...prev, ...Array.from(files)]);
  };

  const paste = (e: React.ClipboardEvent): void => {
    const files = Array.from(e.clipboardData.files).filter((f) =>
      f.type.startsWith("image/") || f.type === "application/pdf" || f.type.startsWith("text/"),
    );
    if (files.length) setAttachments((prev) => [...prev, ...files]);
  };

  const copy = (content: string): void => {
    void navigator.clipboard?.writeText(content);
  };

  const canRegenerate =
    !chat.streaming && chat.timeline.some((t) => t.kind === "msg" && t.role === "assistant");

  // Group the timeline into render segments once per chat change instead of
  // rebuilding it on every render (the render IIFE, history menu, and search
  // all reuse this single memoized result).
  const segments = useMemo(() => buildSegments(chat), [chat]);

  const historyItems = useMemo(() => {
    const items: { idx: number; content: string }[] = [];
    segments.forEach((seg, idx) => {
      if (seg.kind === "msg" && seg.role === "user") {
        items.push({ idx, content: seg.content });
      }
    });
    return items;
  }, [segments]);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const items: { idx: number; content: string; role: "user" | "assistant" }[] = [];
    segments.forEach((seg, idx) => {
      if (seg.kind === "msg") {
        if (seg.content.toLowerCase().includes(q)) {
          items.push({ idx, content: seg.content, role: seg.role });
        }
      } else if (seg.kind === "activity") {
        if (seg.variant === "thinking") {
          const joined = seg.entries.map((e) => e.text ?? "").join("\n");
          if (joined.toLowerCase().includes(q)) {
            items.push({ idx, content: joined, role: "assistant" });
          }
        }
      }
    });
    return items;
  }, [segments, searchQuery]);

  const scrollToSegment = (idx: number, closePanels = true): void => {
    const el = segmentRefs.current[idx];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("highlight-pulse");
      setTimeout(() => el.classList.remove("highlight-pulse"), 1500);
    }
    if (closePanels) {
      setShowSearch(false);
      setShowHistory(false);
    }
  };

  const navigateSearch = (delta: number): void => {
    if (searchResults.length === 0) return;
    const next = (searchIndex + delta + searchResults.length) % searchResults.length;
    setSearchIndex(next);
    scrollToSegment(searchResults[next].idx, false);
  };

  const placeholder = sessionId
    ? t("chat.placeholderActive")
    : t("chat.placeholderIdle");

  return (
    <>
      <div className="topbar">
        <span className="title">{sessionTitle || "DeepWork"}</span>
        <div className="topbar-right">
          {sessionId && (
            <>
              <div className="topbar-menu-wrap search-wrap" ref={searchWrapRef}>
                <button
                  className={`icon-btn ${showSearch ? "active" : ""}`}
                  title={t("chat.searchTitle")}
                  onClick={() => {
                    setShowSearch((v) => !v);
                    setShowHistory(false);
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </button>
                {showSearch && (
                  <div className="search-popover">
                    <div className="search-popover-head">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                      <input
                        ref={searchInputRef}
                        type="text"
                        className="search-popover-input"
                        placeholder={t("chat.searchPlaceholder")}
                        value={searchQuery}
                        onChange={(e) => {
                          setSearchQuery(e.target.value);
                          setSearchIndex(0);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && searchResults[searchIndex]) {
                            e.preventDefault();
                            scrollToSegment(searchResults[searchIndex].idx, false);
                          }
                        }}
                      />
                      {searchResults.length > 0 && (
                        <span className="search-counter">
                          {searchIndex + 1}/{searchResults.length}
                        </span>
                      )}
                      <button
                        className="icon-btn search-nav"
                        title={t("chat.prev")}
                        disabled={searchResults.length === 0}
                        onClick={() => navigateSearch(-1)}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="18 15 12 9 6 15" />
                        </svg>
                      </button>
                      <button
                        className="icon-btn search-nav"
                        title={t("chat.next")}
                        disabled={searchResults.length === 0}
                        onClick={() => navigateSearch(1)}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>
                      <button
                        className="icon-btn search-close"
                        title={t("common.close")}
                        onClick={() => setShowSearch(false)}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                    {searchQuery.trim() && (
                      <div className="search-popover-results">
                        {searchResults.length === 0 ? (
                          <div className="search-popover-empty">{t("chat.noResults")}</div>
                        ) : (
                          searchResults.map((item, i) => (
                            <div
                              key={i}
                              className={`search-popover-result ${i === searchIndex ? "active" : ""}`}
                              onClick={() => {
                                setSearchIndex(i);
                                scrollToSegment(item.idx, false);
                              }}
                            >
                              <span className={`search-result-role ${item.role}`}>
                                {item.role === "user" ? t("chat.roleUser") : <DeepWorkLabel />}
                              </span>
                              <span className="search-result-text">{item.content}</span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="topbar-menu-wrap" ref={historyWrapRef}>
                <button
                  className={`icon-btn ${showHistory ? "active" : ""}`}
                  title={t("chat.historyTitle")}
                  onClick={() => {
                    setShowHistory((v) => !v);
                    setShowSearch(false);
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="12 7 12 12 15 15" />
                    <circle cx="12" cy="12" r="10" />
                  </svg>
                </button>
                {showHistory && (
                  <div className="history-menu">
                    <div className="history-menu-label">{t("chat.historyLabel", { count: historyItems.length })}</div>
                    {historyItems.length === 0 ? (
                      <div className="history-menu-empty">{t("chat.noHistory")}</div>
                    ) : (
                      historyItems.map((item, i) => (
                        <div
                          key={i}
                          className="history-menu-item"
                          title={item.content}
                          onClick={() => scrollToSegment(item.idx)}
                        >
                          {item.content}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
          <button
            className={`icon-btn ${terminalOpen ? "active" : ""}`}
            title={terminalOpen ? t("chat.closeTerminal") : t("chat.openTerminal")}
            onClick={onToggleTerminal}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </button>
          <button
            className={`icon-btn topbar-panel-toggle ${rightPanelOpen ? "active" : ""}`}
            title={terminalOpen ? t("chat.terminalToPanel") : rightPanelOpen ? t("chat.hidePanel") : t("chat.showPanel")}
            onClick={onToggleRightPanel}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <line x1="15" y1="4" x2="15" y2="20" />
            </svg>
          </button>
          </>
          )}
          {updateStatus.state === "available" && (
            <span className="update-banner">{t("chat.updateAvailable", { version: updateStatus.version })}</span>
          )}
          {updateStatus.state === "downloading" && (
            <span className="update-banner">{t("chat.updateDownloading", { percent: updateStatus.percent })}</span>
          )}
          {updateStatus.state === "downloaded" && (
            <button className="btn primary small" onClick={onInstallUpdate}>
              {t("chat.restartToUpdate")}
            </button>
          )}
        </div>
      </div>
      <div className="chat" ref={scrollRef}>
        {!sessionId ? (
          <div className="empty">
            <h2>DeepWork</h2>
            <p>{t("chat.emptyDesc")}</p>
            {funMode && <CommitRunner />}
          </div>
        ) : (
          <>
            {(() => {
              return segments.map((seg, i) => {
                if (seg.kind === "msg") {
                  const isAssistant = seg.role === "assistant";
                  return (
                    <div key={seg.id} ref={(el) => { segmentRefs.current[i] = el; }} className={`msg ${seg.role}`}>
                      <div className="role">{seg.role === "user" ? t("chat.roleUser") : <DeepWorkLabel />}</div>
                      <div className="bubble">
                        {isAssistant ? <Markdown content={seg.content} /> : seg.content}
                      </div>
                      {isAssistant && (
                        <div className="msg-actions">
                          <button title={t("common.copy")} onClick={() => copy(seg.content)}>
                            ⧉
                          </button>
                          <button title={t("chat.regenerate")} onClick={onRegenerate} disabled={!canRegenerate}>
                            ↻
                          </button>
                        </div>
                      )}
                      {isAssistant && seg.stats && <TurnMeta stats={seg.stats} />}
                    </div>
                  );
                }
                if (seg.kind === "activity") {
                  if (seg.variant === "thinking" && !showReasoning) return null;
                  return (
                    <div key={seg.id} ref={(el) => { segmentRefs.current[i] = el; }} className="activity-segment">
                      <ActivityGroup
                        variant={seg.variant}
                        entries={seg.entries}
                        allArtifacts={artifacts}
                        streaming={chat.streaming}
                        isLast={seg.isLast}
                        onJumpToArtifact={onJumpToArtifact}
                      />
                    </div>
                  );
                }
              });
            })()}
          </>
        )}
        {chat.streaming && <ThinkingIndicator chat={chat} />}
        {chat.error && (
          <div className="msg">
            <div className="bubble" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
              {chat.error}
            </div>
          </div>
        )}
      </div>
      <div className="composer">
        {approval && (
          <ApprovalBanner approval={approval} onRespond={onRespondApproval} />
        )}
        {attachments.length > 0 && (
          <div className="attachments">
            {attachments.map((f, i) => (
              <div key={i} className="att-chip" title={f.name}>
                {f.type.startsWith("image/") ? "🖼" : f.type === "application/pdf" ? "📄" : "📎"}{" "}
                <span className="att-name">{f.name}</span>
                <button
                  className="att-remove"
                  onClick={() => setAttachments(attachments.filter((_, idx) => idx !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-box">
          {slashOpen && (
            <div className="slash-menu">
              {slashMatches.length === 0 ? (
                <div className="slash-empty">{t("skills.slashEmpty")}</div>
              ) : (
                slashMatches.map((s, i) => (
                  <div
                    key={s.name}
                    className={`slash-item ${i === slashIndex ? "active" : ""}`}
                    onMouseEnter={() => setSlashIndex(i)}
                    onClick={() => selectSlashSkill(s.name)}
                  >
                    <span className="slash-name">/{s.name}</span>
                    <span className="slash-desc">{s.description}</span>
                  </div>
                ))
              )}
            </div>
          )}
          <textarea
            ref={taRef}
            value={input}
            placeholder={placeholder}
            autoFocus
            rows={1}
            onChange={(e) => {
              const val = e.target.value;
              setInput(val);
              // Detect slash command: input starts with "/" and no whitespace yet.
              const slashMatch = val.match(/^\/(\S*)$/);
              if (slashMatch) {
                setSlashOpen(true);
                setSlashQuery(slashMatch[1]);
                setSlashIndex(0);
              } else {
                setSlashOpen(false);
              }
            }}
            onKeyDown={(e) => {
              if (slashOpen) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashIndex((i) => Math.min(i + 1, slashMatches.length - 1));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashIndex((i) => Math.max(i - 1, 0));
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (slashMatches[slashIndex]) {
                    selectSlashSkill(slashMatches[slashIndex].name);
                  }
                  return;
                }
                if (e.key === "Tab" && slashMatches[slashIndex]) {
                  e.preventDefault();
                  selectSlashSkill(slashMatches[slashIndex].name);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setSlashOpen(false);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={paste}
          />
          <div className="composer-bar">
            <div className="ws-picker-wrap">
              {folderLocked ? (
                <button
                  className={`ws-picker locked ${activeWorkspace ? "active" : ""}`}
                  title={
                    activeWorkspace
                      ? `${activeWorkspace}\n${t("chat.folderLocked")}`
                      : t("chat.folderLocked")
                  }
                  disabled
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
                  <span className="ws-picker-label">{folderLabel}</span>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
                </button>
              ) : (
                <>
                  <button
                    className={`ws-picker ${activeWorkspace ? "active" : ""}`}
                    onClick={() => setShowFolderMenu((v) => !v)}
                    title={activeWorkspace ?? t("chat.chooseFolderOptional")}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
                    <span className="ws-picker-label">{folderLabel}</span>
                    {activeWorkspace && (
                      <span
                        className="ws-clear"
                        onClick={(e) => {
                          e.stopPropagation();
                          clearFolder();
                        }}
                      >
                        ✕
                      </span>
                    )}
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  {showFolderMenu && (
                    <div className="ws-menu" onMouseLeave={() => setShowFolderMenu(false)}>
                      <div className="ws-menu-label">{t("chat.folderMenuTitle")}</div>
                      <div className="ws-menu-item" onClick={pickFolder}>
                        {t("chat.browse")}
                      </div>
                      {recent.length > 0 && <div className="ws-menu-sep" />}
                      {recent.length > 0 && <div className="ws-menu-label">{t("chat.recent")}</div>}
                      {recent.map((r) => (
                        <div
                          key={r.path}
                          className={`ws-menu-item ${activeWorkspace === r.path ? "checked" : ""}`}
                          title={r.path}
                          onClick={() => chooseRecent(r.path)}
                        >
                          <div>
                            <div className="ws-recent-name">{r.name}</div>
                            <div className="ws-recent-path">{r.path}</div>
                          </div>
                        </div>
                      ))}
                      {activeWorkspace && (
                        <>
                          <div className="ws-menu-sep" />
                          <div className="ws-menu-item danger" onClick={clearFolder}>
                            {t("chat.noFolder")}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
            <button
              className="icon-btn"
              title={t("chat.attachTitle")}
              onClick={() => fileRef.current?.click()}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.57 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,application/pdf,.txt,.md,.json,.csv,.tsv,.log,.yml,.yaml,.toml,.ini,text/*"
              style={{ display: "none" }}
              onChange={(e) => {
                onPickFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <div className="composer-right">
              <div className="mode-picker-wrap" ref={modeWrapRef}>
                <button
                  type="button"
                  className="mode-picker"
                  onClick={() => setShowModeMenu((v) => !v)}
                  title={t("chat.permissionMode")}
                >
                  <span className="mode-picker-label">{t(`automations.mode.${currentMode}`)}</span>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                </button>
                {showModeMenu && (
                  <div className="mode-menu">
                    {(["auto", "manual", "plan"] as PermissionMode[]).map((m) => (
                      <div
                        key={m}
                        className={`mode-menu-item ${currentMode === m ? "active" : ""}`}
                        onClick={() => {
                          setPendingMode(m);
                          setShowModeMenu(false);
                        }}
                      >
                        <span>{t(`automations.mode.${m}`)}</span>
                        {currentMode === m && <span className="check">✓</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="model-picker-wrap">
                <button
                  className="model-picker"
                  onClick={() => {
                    void onRefreshModels();
                    setShowModelMenu((v) => !v);
                  }}
                  title={t("chat.chooseModel")}
                >
                  <span className="model-dot" />
                  <span className="model-picker-label">{activeModelLabel}</span>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                </button>
                {showModelMenu && (
                  <div className="model-menu" onMouseLeave={() => setShowModelMenu(false)}>
                    {enabledModels.length === 0 && (
                      <div className="model-menu-empty">
                        {t("chat.noModels")}
                      </div>
                    )}
                    {enabledModels.map((m) => (
                      <div
                        key={m.id}
                        className={`model-menu-item ${activeModel === m.id ? "active" : ""}`}
                        onClick={() => chooseModel(m.id)}
                      >
                        <span>{shortLabel(m)}</span>
                        {activeModel === m.id && <span className="check">✓</span>}
                      </div>
                    ))}
                    <div className="model-menu-sep" />
                      <div
                        className="model-menu-item add-model"
                        onClick={() => {
                          setShowModelMenu(false);
                          onAddModel();
                        }}
                      >
                        <span>{t("chat.addModel")}</span>
                      </div>
                  </div>
                )}
              </div>
              {chat.streaming ? (
                <button className="send-btn stop" onClick={onCancel} title={t("chat.stopGenerating")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                </button>
              ) : (
                <button
                  className="send-btn"
                  onClick={submit}
                  disabled={!input.trim() && attachments.length === 0}
                  title={t("chat.send")}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function shortLabel(m: ConfiguredModel): string {
  // Strip a leading provider prefix for display when the id is "provider:model".
  return m.id.includes(":") ? m.id.split(":").slice(1).join(":") : m.id;
}

/**
 * Shown while the agent is streaming but nothing has appeared yet (model is
 * thinking / preparing its first tool call). Hides as soon as any assistant
 * text or visible tool card exists, since those already convey progress.
 */
function ThinkingIndicator({ chat }: { chat: ChatState }): React.ReactElement | null {
  const { t } = useTranslation();
  const hasAssistantText = chat.timeline.some(
    (t) => t.kind === "msg" && t.role === "assistant" && t.content.trim().length > 0,
  );
  const hasVisibleTool = chat.timeline.some(
    (t) => t.kind === "tool" && chat.tools[t.id] && !HIDDEN_TOOLS.has(chat.tools[t.id].name),
  );
  if (hasAssistantText || hasVisibleTool) return null;
  return (
    <div className="msg assistant">
      <div className="role"><DeepWorkLabel /></div>
      <div className="bubble thinking">
        <span className="thinking-dots">
          <span />
          <span />
          <span />
        </span>
        <span className="thinking-label">{t("chat.thinkingNow")}</span>
      </div>
    </div>
  );
}

/** Tools whose calls we don't render as cards (planning/housekeeping). */
const HIDDEN_TOOLS = new Set(["write_todos", "Task"]);

function prettyToolName(name: string): string {
  const key = `chat.tools.${name}.label`;
  return i18n.exists(key) ? i18n.t(key) : name;
}

/** GUI tools always require per-use approval (no "always allow"). */
const GUI_TOOLS = new Set([
  "screenshot",
  "mouse_move",
  "mouse_click",
  "keyboard_type",
  "keyboard_press",
]);

/**
 * Inline approval prompt rendered above the composer (OpenWorker approvalSlot-style)
 * instead of a blocking modal. Shows what the agent wants to do, the risk level, and
 * allow / always-allow / deny actions.
 */
function ApprovalBanner({
  approval,
  onRespond,
}: {
  approval: Extract<DeepWorkEvent, { type: "approval_requested" }>;
  onRespond: (decision: "allow" | "deny" | "always_allow") => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [peek, setPeek] = useState(approval.name === "execute");
  const isGui = GUI_TOOLS.has(approval.name);
  const hasArgs = !!approval.argsPreview && approval.argsPreview.length > 0;
  return (
    <div className="approval-banner">
      <div className="approval-banner-head">
        <span className="approval-banner-ico" title={t("chat.toolBadge", { name: prettyToolName(approval.name) })}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
        </span>
        <span className="approval-banner-title">
          <Trans
            i18nKey="chat.needApproval"
            components={{ b: <b /> }}
            values={{ name: prettyToolName(approval.name) }}
          />
          {isGui && <span className="approval-banner-gui">{t("chat.controlsScreen")}</span>}
        </span>
        <span className="approval-banner-scope">{approval.risk}</span>
      </div>
      {approval.warning && (
        <div className="approval-banner-warning">
          {approval.warning === "screenshot_exfil"
            ? t("chat.screenshotExfilWarning")
            : approval.warning}
        </div>
      )}
      {hasArgs && (
        <>
          <button
            type="button"
            className="approval-banner-peek"
            onClick={() => setPeek((v) => !v)}
          >
            {peek ? t("chat.hideParams") : t("chat.viewParams")}
          </button>
          {peek && (
            <pre className="approval-banner-preview">
              {formatArgs(approval.name, approval.argsPreview)}
            </pre>
          )}
        </>
      )}
      <div className="approval-banner-actions">
        <button className="btn primary small" onClick={() => onRespond("allow")}>
          {t("chat.allowOnce")}
        </button>
        {!isGui && (
          <button className="btn small" onClick={() => onRespond("always_allow")}>
            {t("chat.alwaysAllow")}
          </button>
        )}
        <span className="spacer" />
        <button className="btn danger small" onClick={() => onRespond("deny")}>
          {t("chat.deny")}
        </button>
      </div>
    </div>
  );
}

interface ToolCardData {
  id: string;
  name: string;
  argsPreview: string;
  outputPreview?: string;
  isError?: boolean;
  status: "running" | "done";
  durationMs?: number;
}

interface ActivityEntry {
  // command variant
  tool?: ToolCardData;
  // thinking variant
  text?: string;
  // true while this specific entry is streaming (only the last thinking entry)
  live?: boolean;
  // stable key for React reconciliation (timeline index for reasoning, tool id
  // for commands) so rows keep their expand/collapse state across rebuilds.
  key?: string;
}

type Segment =
  | {
      id: string;
      kind: "msg";
      role: "user" | "assistant";
      content: string;
      stats?: TurnStats;
    }
  | {
      id: string;
      kind: "activity";
      variant: "command" | "thinking";
      entries: ActivityEntry[];
      isLast: boolean;
    };

/** Group consecutive visible tool calls into a single "steps" segment. */
/**
 * Detects deepagents/internal action markers that leak into assistant content
 * (e.g. "create", "run", "search", "子", "规划"). These are short fragments
 * without punctuation that immediately precede a tool call. Normal replies,
 * even short ones like "好的", are kept because they are not raw action verbs.
 */
const ACTION_MARKERS = new Set([
  // English markers commonly emitted by deepagents/tool-calling loops
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
  // Chinese markers
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
  // Only suppress exact known action verbs that leak from the tool-calling
  // loop. We deliberately do NOT fall back to "any short lowercase word",
  // which falsely hid normal short replies like "ok", "yes", "note", "fix".
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
      // Stable id from the first entry's key (r${timelineIndex} for thinking,
      // t${toolCallId} for commands). Appending new entries to a streaming group
      // keeps the first entry unchanged, so the group retains its id — and its
      // collapsed/expanded state — across every token-driven rebuild.
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
  // Always keep the final assistant message so the summary (if any) is visible.
  let lastAssistantIndex = -1;
  for (let i = 0; i < chat.timeline.length; i++) {
    const item = chat.timeline[i];
    if (item.kind === "msg" && item.role === "assistant") lastAssistantIndex = i;
  }
  for (let i = 0; i < chat.timeline.length; i++) {
    const item = chat.timeline[i];
    if (item.kind === "msg") {
      // Suppress internal fragments that sit between activity phases so they
      // don't split otherwise-consecutive thinking/command groups. This covers:
      //  - empty assistant messages (content:"") created by stray message_delta
      //  - short action-marker fragments ("create", "执行", …) that immediately
      //    precede a tool call or another reasoning phase.
      // The final assistant message is never suppressed — it may be the summary.
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
  // Mark the last thinking entry as live while the turn is still streaming and
  // this is the tail group (so it shows "正在思考…" instead of a char count).
  // Walk backward to find the tail thinking group rather than only checking the
  // final segment (which may be a trailing assistant message).
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

/**
 * A run of consecutive same-variant activities (tool commands OR thinking
 * phases), rendered as one collapsible group. Command and thinking share the
 * exact same DOM and styles — only the title wording, dot color, and row
 * content differ via the `variant` prop.
 *
 * Command: blue spinner while running, green when done, red on error; shows a
 * "等待 agent…" row between steps and inlines produced artifacts when finished.
 * Thinking: the dot is always blue; the last entry shows "正在思考…" while live.
 */
function ActivityGroup({
  variant,
  entries,
  allArtifacts,
  streaming,
  isLast,
  onJumpToArtifact,
}: {
  variant: "command" | "thinking";
  entries: ActivityEntry[];
  allArtifacts: ArtifactFile[];
  streaming: boolean;
  isLast: boolean;
  onJumpToArtifact: (path: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const tools = variant === "command" ? entries.map((e) => e.tool!).filter(Boolean) : [];
  const isThinking = variant === "thinking";

  const anyRunning = isThinking
    ? entries.some((e) => e.live)
    : tools.some((tl) => tl.status === "running");
  const anyError = !isThinking && tools.some((tl) => tl.isError);
  const allDone = !isThinking && tools.every((tl) => tl.status === "done");
  // The agent is "between steps" when the turn is still streaming, this is the
  // latest group, and no command is currently in flight (model is thinking/calling).
  const waiting = !isThinking && streaming && isLast && !anyRunning;
  const finished = !isThinking && !streaming && allDone;
  const count = entries.length;

  const title = isThinking
    ? anyRunning
      ? t("chat.thinkingRunning", { count })
      : t("chat.thinkingFinished", { count })
    : anyRunning
      ? t("chat.stepsRunning", { count })
      : finished
        ? t("chat.stepsFinished", { count })
        : t("chat.stepsIdle", { count });

  // Group header dot is always neutral gray; the concrete status color
  // (blue=running, green=done, red=error) is shown on each expanded row.
  const headDotClass = "group";

  return (
    <div className={`steps-group activity-group ${variant}`}>
      <button
        type="button"
        className="steps-head"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="steps-caret">{open ? "▾" : "▸"}</span>
        <span className={`steps-dot ${headDotClass}`} />
        <span className="steps-title">{title}</span>
      </button>
      {open && (
        <div className="steps-body">
          {entries.map((entry, i) => (
            <ActivityRow
              key={entry.key ?? i}
              variant={variant}
              entry={entry}
            />
          ))}
          {finished && !anyError && (
            <ProducedArtifacts
              tools={tools}
              allArtifacts={allArtifacts}
              onJumpToArtifact={onJumpToArtifact}
            />
          )}
          {waiting && (
            <div className="step-row waiting">
              <span className="step-spinner" />
              <span className="step-label dim">{t("chat.waitingForAgent")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A single row inside an ActivityGroup. Same shell for both variants; the
 * content adapts: a command row shows verb/target/duration + expandable
 * args/output, while a thinking row shows the char count (or "正在思考…") +
 * expandable reasoning text.
 */
function ActivityRow({
  variant,
  entry,
}: {
  variant: "command" | "thinking";
  entry: ActivityEntry;
}): React.ReactElement {
  const { t } = useTranslation();
  const tool = entry.tool;
  const thinkingText = entry.text ?? "";
  const isThinking = variant === "thinking";

  const [open, setOpen] = useState(!isThinking && !!tool?.isError);
  useEffect(() => {
    if (!isThinking && tool?.isError) setOpen(true);
  }, [isThinking, tool?.isError]);

  const running = isThinking ? !!entry.live : tool?.status === "running";

  const verb = isThinking ? t("chat.thinking") : stepVerb(tool!.name);
  const target = isThinking
    ? entry.live
      ? null
      : thinkingText.trim()
        ? `${thinkingText.length} ${t("chat.chars")}`
        : null
    : summarize(tool!);
  const duration = !isThinking && tool?.durationMs !== undefined && !running
    ? tool.durationMs
    : undefined;

  const hasDetail = isThinking
    ? thinkingText.trim().length > 0
    : (!!tool?.outputPreview && tool.outputPreview.trim().length > 0) ||
      (!!tool?.argsPreview && tool.argsPreview.length > 20);

  const dotClass = isThinking
    ? "thinking"
    : running
      ? "running"
      : tool?.isError
        ? "error"
        : "done";

  const copy = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (isThinking) {
      void navigator.clipboard?.writeText(thinkingText);
      return;
    }
    void navigator.clipboard?.writeText(
      tool!.name === "execute"
        ? String(parseArgs(tool!.argsPreview)?.command ?? tool!.argsPreview)
        : tool!.argsPreview,
    );
  };

  return (
    <div className={`step-row ${!isThinking && tool?.isError ? "error" : ""} ${open ? "open" : ""}`}>
      <button
        type="button"
        className="step-head"
        onClick={() => hasDetail && setOpen((v) => !v)}
        disabled={!hasDetail}
      >
        <span className={`step-dot ${dotClass}`} />
        <span className="step-label">
          <span className="step-verb">{verb}</span>
          {target && (
            <span className="step-target" title={isThinking ? undefined : target}>{target}</span>
          )}
          {isThinking && entry.live && (
            <span className="reasoning-status">{t("chat.thinkingNow")}</span>
          )}
          {duration !== undefined && (
            <span className="step-dur">{fmtSec(duration)}</span>
          )}
        </span>
        {hasDetail && (
          <span
            className="step-copy"
            role="button"
            title={t("common.copy")}
            onClick={copy}
          >
            ⧉
          </span>
        )}
        <span className="step-caret">{hasDetail ? (open ? "▾" : "▸") : ""}</span>
      </button>
      {open && hasDetail && (
        <div className="step-detail">
          {isThinking ? (
            <div className="reasoning-body">{thinkingText}</div>
          ) : (
            <>
              {tool!.argsPreview && (
                <pre className="tc-args">{formatArgs(tool!.name, tool!.argsPreview)}</pre>
              )}
              {tool!.outputPreview && (
                <pre className={`tc-output ${tool!.isError ? "error" : ""}`}>
                  {tool!.outputPreview}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * After the steps finish, inline any files these steps produced (write_file /
 * edit_file) as artifact cards the user can open directly.
 */
function ProducedArtifacts({
  tools,
  allArtifacts,
  onJumpToArtifact,
}: {
  tools: ToolCardData[];
  allArtifacts: ArtifactFile[];
  onJumpToArtifact: (path: string) => void;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const produced: ArtifactFile[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (tool.name !== "write_file" && tool.name !== "edit_file") continue;
    const path = String(parseArgs(tool.argsPreview)?.file_path ?? "");
    const name = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
    const match =
      allArtifacts.find((a) => a.name === name || a.absolutePath === path) ??
      allArtifacts.find((a) => a.absolutePath.endsWith("/" + name) || a.absolutePath.endsWith("\\" + name));
    if (match && !seen.has(match.absolutePath)) {
      seen.add(match.absolutePath);
      produced.push(match);
    }
  }
  if (produced.length === 0) return null;
  return (
    <div className="produced-artifacts">
      {produced.map((f) => (
        <button
          key={f.absolutePath}
          type="button"
          className="artifact-chip"
          onClick={() => onJumpToArtifact(f.absolutePath)}
          title={f.absolutePath}
        >
          <span className="artifact-icon">{fileIcon(f.ext)}</span>
          <span className="artifact-name">{f.name}</span>
          <span className="artifact-open">{t("chat.viewInArtifacts")}</span>
        </button>
      ))}
    </div>
  );
}

function stepVerb(name: string): string {
  const key = `chat.tools.${name}.verb`;
  return i18n.exists(key) ? i18n.t(key) : prettyToolName(name);
}

function fileIcon(ext: string): string {
  if (["html", "htm"].includes(ext)) return "🌐";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return "🖼";
  if (["pdf"].includes(ext)) return "📄";
  if (["js", "ts", "jsx", "tsx", "py", "go", "rs", "java", "c", "cpp"].includes(ext)) return "📜";
  return "📄";
}

/** Best-effort parse of the JSON-encoded tool args. */
function parseArgs(preview: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(preview);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** One-line summary shown on the collapsed card. */
function summarize(tool: ToolCardData): string {
  const args = parseArgs(tool.argsPreview);
  if (!args) return tool.argsPreview;
  switch (tool.name) {
    case "execute":
      return String(args.command ?? "");
    case "write_file":
    case "edit_file":
    case "read_file":
      return shortPath(String(args.file_path ?? args.path ?? ""));
    case "ls":
    case "glob":
    case "grep":
      return shortPath(
        String(args.path ?? args.pattern ?? args.query ?? ""),
      );
    case "web_search":
      return String(args.query ?? "");
    case "web_fetch":
      return String(args.url ?? "");
    default: {
      const first = Object.values(args)[0];
      return first != null ? String(first) : "";
    }
  }
}

function shortPath(p: string): string {
  if (!p) return "";
  // Collapse an absolute sandbox path to its last two segments.
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : p;
}

/** Compact token count, e.g. 1280 -> "1.3k". */
function fmtTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
  return String(n);
}

/** Milliseconds -> "1.2s" (sub-second kept to one decimal). */
function fmtSec(ms: number): string {
  return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms";
}

/** Strip a provider prefix ("openai:gpt-4o" -> "gpt-4o"). */
function modelLabel(model: string): string {
  const i = model.indexOf(":");
  return i >= 0 ? model.slice(i + 1) : model;
}

/** Per-reply telemetry footer: model · tokens · latency (+ truncation warn). */
function TurnMeta({ stats }: { stats: TurnStats }): React.ReactElement {
  const { t } = useTranslation();
  const truncated = stats.finishReason === "length";
  const filtered = stats.finishReason === "content_filter";
  return (
    <div className="msg-meta">
      <span className="meta-model">{modelLabel(stats.model)}</span>
      <span className="meta-sep">·</span>
      <span>{t("chat.tokensIn", { n: fmtTokens(stats.inputTokens) })}</span>
      <span className="meta-sep">/</span>
      <span>{t("chat.tokensOut", { n: fmtTokens(stats.outputTokens) })}</span>
      {stats.firstTokenMs !== undefined && (
        <>
          <span className="meta-sep">·</span>
          <span>{t("chat.firstToken", { t: fmtSec(stats.firstTokenMs) })}</span>
        </>
      )}
      <span className="meta-sep">·</span>
      <span>{t("chat.totalTime", { t: fmtSec(stats.durationMs) })}</span>
      {truncated && <span className="meta-warn">⚠ {t("chat.truncated")}</span>}
      {filtered && <span className="meta-warn">⚠ {t("chat.contentFiltered")}</span>}
    </div>
  );
}

/** Pretty, readable representation of the args for the expanded body. */
function formatArgs(name: string, preview: string): string {
  const args = parseArgs(preview);
  if (!args) return preview;
  if (name === "execute" && typeof args.command === "string") {
    return "$ " + args.command;
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return preview;
  }
}
