import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatState } from "../App";
import type {
  ConfiguredModel,
  TodoItem,
  UpdateStatus,
} from "../../../shared/types";
import { Markdown } from "./Markdown";
import { TodoPanel } from "./TodoPanel";

interface RecentFolder {
  path: string;
  name: string;
}

interface Props {
  sessionId: string | null;
  chat: ChatState;
  todos: TodoItem[];
  updateStatus: UpdateStatus;
  workspaceDir?: string;
  sessionModel?: string;
  enabledModels: ConfiguredModel[];
  showReasoning?: boolean;
  onSend: (
    text: string,
    attachments?: File[],
    workspaceDir?: string,
    modelId?: string,
  ) => void;
  onCancel: () => void;
  onRegenerate: () => void;
  onSetModel: (modelId: string) => void;
  onRefreshModels: () => void | Promise<void>;
  onAddModel: () => void;
  onNewSession: () => void;
  onToggleRightPanel: () => void;
  rightCollapsed: boolean;
  onInstallUpdate: () => void;
}

export function Chat({
  sessionId,
  chat,
  todos,
  updateStatus,
  workspaceDir,
  sessionModel,
  enabledModels,
  showReasoning = true,
  onSend,
  onCancel,
  onRegenerate,
  onSetModel,
  onRefreshModels,
  onAddModel,
  onNewSession,
  onToggleRightPanel,
  rightCollapsed,
  onInstallUpdate,
}: Props): React.ReactElement {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [showFolderMenu, setShowFolderMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [recent, setRecent] = useState<RecentFolder[]>([]);
  // Workspace/model chosen for a brand-new session (before it is created).
  const [pendingWorkspace, setPendingWorkspace] = useState<string | undefined>(undefined);
  const [pendingModel, setPendingModel] = useState<string | undefined>(undefined);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const activeModel = sessionModel ?? pendingModel ?? enabledModels[0]?.id;
  const activeModelLabel = useMemo(() => {
    if (!activeModel) return "No model";
    const m = enabledModels.find((x) => x.id === activeModel);
    return m ? shortLabel(m) : activeModel.split(":").pop();
  }, [activeModel, enabledModels]);

  const activeWorkspace = workspaceDir ?? pendingWorkspace;
  const folderLabel = useMemo(() => {
    if (!activeWorkspace) return "选择文件夹（可选）";
    const parts = activeWorkspace.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] || activeWorkspace;
  }, [activeWorkspace]);

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

  const submit = (): void => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || chat.streaming) return;
    setInput("");
    setAttachments([]);
    void onSend(text, attachments, activeWorkspace, activeModel);
    setPendingWorkspace(undefined);
    setPendingModel(undefined);
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
  const completedTodos = todos.filter((t) => t.status === "completed").length;

  const placeholder = sessionId
    ? "Message DeepWork…  (Enter to send, Shift+Enter for newline)"
    : "Ask anything — a new chat starts automatically";

  return (
    <>
      <div className="topbar">
        <span className="title">{sessionId ? "Chat" : "DeepWork"}</span>
        <div className="topbar-right">
          {updateStatus.state === "available" && (
            <span className="update-banner">Update available ({updateStatus.version})</span>
          )}
          {updateStatus.state === "downloading" && (
            <span className="update-banner">Downloading update… {updateStatus.percent}%</span>
          )}
          {updateStatus.state === "downloaded" && (
            <button className="btn primary small" onClick={onInstallUpdate}>
              Restart to update
            </button>
          )}
          <button
            className="icon-btn rp-toggle"
            onClick={onToggleRightPanel}
            title={rightCollapsed ? "展开右栏" : "折叠右栏"}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <line x1="15" y1="4" x2="15" y2="20" />
            </svg>
          </button>
        </div>
      </div>
      <div className="chat" ref={scrollRef}>
        {!sessionId ? (
          <div className="empty">
            <h2>DeepWork</h2>
            <p>Your local desktop AI agent.</p>
            <button className="new-chat" style={{ marginTop: 12 }} onClick={onNewSession}>
              Start a chat
            </button>
          </div>
        ) : (
          <>
            {todos.length > 0 && <TodoPanel todos={todos} completed={completedTodos} />}
            {chat.timeline.map((item, i) => {
              if (item.kind === "msg") {
                const isAssistant = item.role === "assistant";
                return (
                  <div key={i} className={`msg ${item.role}`}>
                    <div className="role">{item.role}</div>
                    <div className="bubble">
                      {isAssistant && showReasoning && item.reasoning && (
                        <details className="reasoning">
                          <summary>思考过程</summary>
                          <div className="reasoning-body">{item.reasoning}</div>
                        </details>
                      )}
                      {isAssistant ? <Markdown content={item.content} /> : item.content}
                    </div>
                    {isAssistant && (
                      <div className="msg-actions">
                        <button title="Copy" onClick={() => copy(item.content)}>
                          ⧉
                        </button>
                        <button title="Regenerate" onClick={onRegenerate} disabled={!canRegenerate}>
                          ↻
                        </button>
                      </div>
                    )}
                  </div>
                );
              }
              const t = chat.tools[item.id];
              if (!t) return null;
              return (
                <div key={i} className={`tool-card ${t.isError ? "error" : ""}`}>
                  <div className="inner">
                    <div>
                      {t.status === "running" ? "⏳ " : t.isError ? "✕ " : "✓ "}
                      <span className="tname">{t.name}</span>
                    </div>
                    <div className="targs">{t.argsPreview}</div>
                    {t.outputPreview && (
                      <div className="targs" style={{ marginTop: 4 }}>
                        → {t.outputPreview}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        )}
        {chat.error && (
          <div className="msg">
            <div className="bubble" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
              {chat.error}
            </div>
          </div>
        )}
      </div>
      <div className="composer">
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
          <textarea
            ref={taRef}
            value={input}
            placeholder={placeholder}
            autoFocus
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={paste}
          />
          <div className="composer-bar">
            <div className="ws-picker-wrap">
              <button
                className={`ws-picker ${activeWorkspace ? "active" : ""}`}
                onClick={() => setShowFolderMenu((v) => !v)}
                title={activeWorkspace ?? "Choose a folder (optional)"}
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
                  <div className="ws-menu-label">选择文件夹</div>
                  <div className="ws-menu-item" onClick={pickFolder}>
                    📂 浏览…
                  </div>
                  {recent.length > 0 && <div className="ws-menu-sep" />}
                  {recent.length > 0 && <div className="ws-menu-label">最近</div>}
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
                        ✕ 不使用文件夹
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
            <button
              className="icon-btn"
              title="Attach image, PDF or text file"
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
              <div className="model-picker-wrap">
                <button
                  className="model-picker"
                  onClick={() => {
                    void onRefreshModels();
                    setShowModelMenu((v) => !v);
                  }}
                  title="选择模型"
                >
                  <span className="model-dot" />
                  <span className="model-picker-label">{activeModelLabel}</span>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                </button>
                {showModelMenu && (
                  <div className="model-menu" onMouseLeave={() => setShowModelMenu(false)}>
                    {enabledModels.length === 0 && (
                      <div className="model-menu-empty">
                        还没有可用模型。
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
                      <span>+ 新增模型</span>
                    </div>
                  </div>
                )}
              </div>
              {chat.streaming ? (
                <button className="send-btn stop" onClick={onCancel} title="Stop generating">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                </button>
              ) : (
                <button
                  className="send-btn"
                  onClick={submit}
                  disabled={!input.trim() && attachments.length === 0}
                  title="Send"
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
