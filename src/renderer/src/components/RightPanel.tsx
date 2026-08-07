import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ArtifactFile, MemoryItem, MemoryType, TodoItem } from "../../../shared/types";

interface Props {
  sessionId: string | null;
  todos: TodoItem[];
  artifacts: ArtifactFile[];
  onRefreshArtifacts: () => void;
  onClose?: () => void;
  /** When set, scroll the matching artifact into view and flash-highlight it. */
  highlightArtifact?: { path: string; n: number } | null;
}

const ICONS: Record<string, string> = {
  md: "📝",
  txt: "📄",
  pdf: "📕",
  doc: "📘",
  docx: "📘",
  xls: "📊",
  xlsx: "📊",
  csv: "📊",
  png: "🖼",
  jpg: "🖼",
  jpeg: "🖼",
  gif: "🖼",
  svg: "🖼",
  html: "🌐",
  htm: "🌐",
  json: "⚙️",
  js: "⚙️",
  ts: "⚙️",
  py: "🐍",
  sh: "⌨️",
  zip: "🗜",
};

const MEM_TYPES: Array<MemoryType | ""> = ["", "preference", "fact", "event"];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timeLabel(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function RightPanel({
  sessionId,
  todos,
  artifacts,
  onRefreshArtifacts,
  onClose,
  highlightArtifact,
}: Props): React.ReactElement | null {
  const { t } = useTranslation();
  const [progressOpen, setProgressOpen] = useState(true);
  const [artifactsOpen, setArtifactsOpen] = useState(true);
  const [memOpen, setMemOpen] = useState(true);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [memFilter, setMemFilter] = useState<MemoryType | "">("");
  const [addText, setAddText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const listRef = useRef<HTMLUListElement>(null);

  // Auto-refresh artifacts when the session first loads.
  useEffect(() => {
    if (sessionId) onRefreshArtifacts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Memories: load on mount / session change.
  const refreshMemories = useCallback(async () => {
    try {
      const items = await window.deepwork.memories.list();
      setMemories(items);
    } catch {
      // ignore IPC failures
    }
  }, []);
  useEffect(() => {
    void refreshMemories();
  }, [refreshMemories, sessionId]);

  const filtered = memFilter
    ? memories.filter((m) => m.type === memFilter)
    : memories;

  const handleAdd = async (): Promise<void> => {
    const text = addText.trim();
    if (!text) return;
    await window.deepwork.memories.add(text);
    setAddText("");
    await refreshMemories();
  };
  const startEdit = (m: MemoryItem): void => {
    setEditingId(m.id);
    setEditText(m.content);
  };
  const handleEdit = async (): Promise<void> => {
    const text = editText.trim();
    if (!text || !editingId) return;
    await window.deepwork.memories.edit(editingId, text);
    setEditingId(null);
    setEditText("");
    await refreshMemories();
  };
  const handleDelete = async (id: string): Promise<void> => {
    await window.deepwork.memories.remove(id);
    await refreshMemories();
  };
  const memTypeLabel = (type?: MemoryType): string => {
    if (type === "preference") return t("rightPanel.typePreference");
    if (type === "fact") return t("rightPanel.typeFact");
    if (type === "event") return t("rightPanel.typeEvent");
    return "";
  };

  // Jump-to-artifact: open the section, scroll the row into view, flash it.
  useEffect(() => {
    if (!highlightArtifact) return;
    setArtifactsOpen(true);
    const raf = requestAnimationFrame(() => {
      const sel = `[data-path="${CSS.escape(highlightArtifact.path)}"]`;
      const el = listRef.current?.querySelector<HTMLElement>(sel);
      if (!el) return;
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      el.classList.remove("flash");
      void el.offsetWidth; // restart the animation
      el.classList.add("flash");
    });
    return () => cancelAnimationFrame(raf);
  }, [highlightArtifact]);

  // Auto-collapse the progress section when there are no steps.
  const hasTasks = todos.length > 0;
  const hasArtifacts = artifacts.length > 0;
  const hasSession = !!sessionId;

  return (
    <aside className="right-panel">
      <div className="rp-topbar">
        <span className="rp-title">{t("rightPanel.title")}</span>
        {onClose && (
          <button className="rp-close" onClick={onClose} title={t("close")}>✕</button>
        )}
      </div>
      {hasSession && hasTasks && (
        <section className="rp-section">
          <button
            className="rp-head"
            onClick={() => setProgressOpen((v) => !v)}
          >
            <span className="rp-caret">{progressOpen ? "▾" : "▸"}</span>
            <span>{t("rightPanel.tasks")}</span>
            <span className="rp-count">{todos.length}</span>
          </button>
          {progressOpen && (
            <ul className="rp-tasks">
              {todos.map((t, i) => (
                <li key={i} className={`rp-task ${t.status}`}>
                  <span className="rp-task-icon">
                    {t.status === "completed"
                      ? "✓"
                      : t.status === "in_progress"
                        ? "◐"
                        : "○"}
                  </span>
                  <span className="rp-task-label">{t.content}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {hasSession && (
      <section className="rp-section">
        <button
          className="rp-head"
          onClick={() => setArtifactsOpen((v) => !v)}
        >
          <span className="rp-caret">{artifactsOpen ? "▾" : "▸"}</span>
          <span>{t("rightPanel.artifacts")}</span>
          {hasArtifacts && <span className="rp-count">{artifacts.length}</span>}
          <span
            className="rp-refresh"
            role="button"
            title={t("rightPanel.refresh")}
            onClick={(e) => {
              e.stopPropagation();
              onRefreshArtifacts();
            }}
          >
            ↻
          </span>
          <span
            className="rp-open-folder"
            role="button"
            title={t("rightPanel.showInFinder")}
            onClick={(e) => {
              e.stopPropagation();
              if (artifacts[0]) {
                window.deepwork.artifacts.reveal(artifacts[0].absolutePath);
              }
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          </span>
        </button>
        {artifactsOpen && (
          <>
            {hasArtifacts ? (
              <ul className="rp-artifacts" ref={listRef}>
                {artifacts.map((a) => (
                  <li key={a.absolutePath} className="rp-artifact" data-path={a.absolutePath}>
                    <div className="rp-artifact-main">
                      <span className="rp-artifact-icon">{ICONS[a.ext] ?? "📄"}</span>
                      <div className="rp-artifact-meta">
                        <div className="rp-artifact-name" title={a.relativePath}>
                          {a.name}
                        </div>
                        <div className="rp-artifact-sub">
                          {formatSize(a.size)} · {timeLabel(a.modifiedAt)}
                        </div>
                      </div>
                    </div>
                    <button
                      className="rp-artifact-open"
                      onClick={() => window.deepwork.artifacts.open(a.absolutePath)}
                      title={t("rightPanel.open")}
                    >
                      {t("rightPanel.open")}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rp-empty">{t("rightPanel.emptyArtifacts")}</p>
            )}
          </>
        )}
      </section>
      )}

      <section className="rp-section">
        <button
          className="rp-head"
          onClick={() => setMemOpen((v) => !v)}
        >
          <span className="rp-caret">{memOpen ? "▾" : "▸"}</span>
          <span>{t("rightPanel.memories")}</span>
          {memories.length > 0 && <span className="rp-count">{memories.length}</span>}
          <span
            className="rp-refresh"
            role="button"
            title={t("rightPanel.refresh")}
            onClick={(e) => {
              e.stopPropagation();
              void refreshMemories();
            }}
          >
            ↻
          </span>
        </button>
        {memOpen && (
          <div className="rp-memories">
            <div className="rp-mem-add">
              <input
                className="rp-mem-input"
                placeholder={t("rightPanel.memoryPlaceholder")}
                value={addText}
                onChange={(e) => setAddText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleAdd();
                }}
              />
              <button className="rp-mem-add-btn" onClick={() => void handleAdd()}>
                {t("rightPanel.addMemory")}
              </button>
            </div>
            <div className="rp-mem-filter">
              {MEM_TYPES.map((tp) => (
                <button
                  key={tp || "all"}
                  className={`rp-mem-chip ${memFilter === tp ? "active" : ""}`}
                  onClick={() => setMemFilter(tp)}
                >
                  {tp === "" ? t("rightPanel.all") : memTypeLabel(tp)}
                </button>
              ))}
            </div>
            {filtered.length === 0 ? (
              <p className="rp-empty">{t("rightPanel.emptyMemories")}</p>
            ) : (
              <ul className="rp-mem-list">
                {filtered.map((m) => (
                  <li key={m.id} className="rp-mem-item">
                    {editingId === m.id ? (
                      <div className="rp-mem-edit">
                        <textarea
                          className="rp-mem-textarea"
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                        />
                        <div className="rp-mem-edit-actions">
                          <button onClick={() => void handleEdit()}>
                            {t("rightPanel.saveMemory")}
                          </button>
                          <button
                            onClick={() => {
                              setEditingId(null);
                              setEditText("");
                            }}
                          >
                            {t("rightPanel.cancel")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="rp-mem-content">{m.content}</div>
                        {m.type && (
                          <span className="rp-mem-type">{memTypeLabel(m.type)}</span>
                        )}
                        <div className="rp-mem-actions">
                          <button onClick={() => startEdit(m)}>
                            {t("rightPanel.editMemory")}
                          </button>
                          <button
                            className="rp-mem-del"
                            onClick={() => void handleDelete(m.id)}
                          >
                            {t("rightPanel.deleteMemory")}
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </aside>
  );
}
