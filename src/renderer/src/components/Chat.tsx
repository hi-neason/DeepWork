import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatState } from "../App";
import type {
  ConfiguredModel,
  TodoItem,
  UpdateStatus,
} from "../../../shared/types";
import { Markdown } from "./Markdown";

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
  onInstallUpdate: () => void;
  rightPanelOpen: boolean;
  onToggleRightPanel: () => void;
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
  onInstallUpdate,
  rightPanelOpen,
  onToggleRightPanel,
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

  const placeholder = sessionId
    ? "Message DeepWork…  (Enter to send, Shift+Enter for newline)"
    : "Ask anything — a new chat starts automatically";

  return (
    <>
      <div className="topbar">
        <span className="title">{sessionId ? "Chat" : "DeepWork"}</span>
        <div className="topbar-right">
          <button
            className={`icon-btn topbar-panel-toggle ${rightPanelOpen ? "active" : ""}`}
            title={rightPanelOpen ? "隐藏右侧面板" : "显示右侧面板"}
            onClick={onToggleRightPanel}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <line x1="15" y1="4" x2="15" y2="20" />
            </svg>
          </button>
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
              // Planning/todo tools are surfaced in the right panel; don't
              // dump their raw JSON into the transcript.
              if (HIDDEN_TOOLS.has(t.name)) return null;
              return <ToolCard key={i} tool={t} />;
            })}
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

/**
 * Shown while the agent is streaming but nothing has appeared yet (model is
 * thinking / preparing its first tool call). Hides as soon as any assistant
 * text or visible tool card exists, since those already convey progress.
 */
function ThinkingIndicator({ chat }: { chat: ChatState }): React.ReactElement | null {
  const hasAssistantText = chat.timeline.some(
    (t) => t.kind === "msg" && t.role === "assistant" && t.content.trim().length > 0,
  );
  const hasVisibleTool = chat.timeline.some(
    (t) => t.kind === "tool" && chat.tools[t.id] && !HIDDEN_TOOLS.has(chat.tools[t.id].name),
  );
  if (hasAssistantText || hasVisibleTool) return null;
  return (
    <div className="msg assistant">
      <div className="role">assistant</div>
      <div className="bubble thinking">
        <span className="thinking-dots">
          <span />
          <span />
          <span />
        </span>
        <span className="thinking-label">正在思考…</span>
      </div>
    </div>
  );
}

/** Tools whose calls we don't render as cards (planning/housekeeping). */
const HIDDEN_TOOLS = new Set(["write_todos", "Task"]);

function prettyToolName(name: string): string {
  const labels: Record<string, string> = {
    write_file: "写入文件",
    edit_file: "编辑文件",
    read_file: "读取文件",
    ls: "列出目录",
    execute: "执行命令",
    grep: "搜索",
    glob: "查找文件",
    web_search: "网页搜索",
    web_fetch: "抓取网页",
    write_todos: "更新任务",
  };
  return labels[name] ?? name;
}

interface ToolCardData {
  id: string;
  name: string;
  argsPreview: string;
  outputPreview?: string;
  isError?: boolean;
  status: "running" | "done";
}

/**
 * A collapsible tool/command card. Collapsed it shows status + a one-line
 * summary (the command, file path, or query); expanded it shows the full
 * arguments and any output (e.g. a command's execution log).
 */
function ToolCard({ tool }: { tool: ToolCardData }): React.ReactElement {
  // Failed tools auto-expand so the error is visible without a click.
  const [open, setOpen] = useState(!!tool.isError);
  useEffect(() => {
    if (tool.isError) setOpen(true);
  }, [tool.isError]);
  const running = tool.status === "running";
  const icon = running ? "⏳" : tool.isError ? "✕" : "✓";
  const summary = summarize(tool);
  // Auto-expand failed tools and long-running command output.
  const hasDetail =
    (tool.outputPreview && tool.outputPreview.trim().length > 0) ||
    (tool.argsPreview && tool.argsPreview.length > 20);
  const copy = (e: React.MouseEvent): void => {
    e.stopPropagation();
    void navigator.clipboard?.writeText(
      tool.name === "execute"
        ? String(parseArgs(tool.argsPreview)?.command ?? tool.argsPreview)
        : tool.argsPreview,
    );
  };
  return (
    <div className={`tool-card ${tool.isError ? "error" : ""} ${open ? "open" : ""}`}>
      <button
        type="button"
        className="tc-head"
        onClick={() => hasDetail && setOpen((v) => !v)}
        disabled={!hasDetail}
      >
        <span className="tc-caret">{hasDetail ? (open ? "▾" : "▸") : ""}</span>
        <span className="tc-status">{icon}</span>
        <span className="tname">{prettyToolName(tool.name)}</span>
        {summary && <span className="tc-summary" title={summary}>{summary}</span>}
        {running && <span className="tc-spinner" />}
        {hasDetail && (
          <span
            className="tc-copy"
            role="button"
            title="复制"
            onClick={copy}
          >
            ⧉
          </span>
        )}
      </button>
      {open && hasDetail && (
        <div className="tc-body">
          {tool.argsPreview && (
            <pre className="tc-args">{formatArgs(tool.name, tool.argsPreview)}</pre>
          )}
          {tool.outputPreview && (
            <pre className={`tc-output ${tool.isError ? "error" : ""}`}>
              {tool.outputPreview}
            </pre>
          )}
        </div>
      )}
    </div>
  );
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
