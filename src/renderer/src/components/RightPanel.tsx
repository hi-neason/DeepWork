import { useEffect, useRef, useState } from "react";
import type { ArtifactFile, TodoItem } from "../../../shared/types";

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
  const [progressOpen, setProgressOpen] = useState(true);
  const [artifactsOpen, setArtifactsOpen] = useState(true);
  const listRef = useRef<HTMLUListElement>(null);

  // Auto-refresh artifacts when the session first loads.
  useEffect(() => {
    if (sessionId) onRefreshArtifacts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

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

  return (
    <aside className="right-panel">
      <div className="rp-topbar">
        <span className="rp-title">面板</span>
      </div>
      {hasTasks && (
        <section className="rp-section">
          <button
            className="rp-head"
            onClick={() => setProgressOpen((v) => !v)}
          >
            <span className="rp-caret">{progressOpen ? "▾" : "▸"}</span>
            <span>任务进程</span>
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

      <section className="rp-section">
        <button
          className="rp-head"
          onClick={() => setArtifactsOpen((v) => !v)}
        >
          <span className="rp-caret">{artifactsOpen ? "▾" : "▸"}</span>
          <span>产物</span>
          {hasArtifacts && <span className="rp-count">{artifacts.length}</span>}
          <span
            className="rp-refresh"
            role="button"
            title="刷新"
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
            title="在 Finder 中显示文件夹"
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
                      title="打开"
                    >
                      打开
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rp-empty">这个会话的产物会显示在这里。</p>
            )}
          </>
        )}
      </section>
    </aside>
  );
}
