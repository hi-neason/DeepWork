import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ArtifactFile, TodoItem } from "../../../shared/types";
import { formatBytes } from "../lib/format";
import {
  Archive,
  Braces,
  CheckCircle2,
  Circle,
  CircleDotDashed,
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FileType2,
  FolderOpen,
  Globe2,
  Image,
  RefreshCw,
  TerminalSquare,
  X,
  type LucideIcon,
} from "lucide-react";

interface Props {
  sessionId: string | null;
  todos: TodoItem[];
  artifacts: ArtifactFile[];
  onRefreshArtifacts: () => void;
  onClose?: () => void;
  /** When set, scroll the matching artifact into view and flash-highlight it. */
  highlightArtifact?: { path: string; n: number } | null;
}

const ICONS: Record<string, LucideIcon> = {
  md: FileText,
  txt: FileText,
  pdf: FileType2,
  doc: FileText,
  docx: FileText,
  xls: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  csv: FileSpreadsheet,
  png: Image,
  jpg: Image,
  jpeg: Image,
  gif: Image,
  svg: Image,
  html: Globe2,
  htm: Globe2,
  json: Braces,
  js: FileCode2,
  ts: FileCode2,
  py: FileCode2,
  sh: TerminalSquare,
  zip: Archive,
};

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
  const hasSession = !!sessionId;

  return (
    <aside className="right-panel">
      <div className="rp-topbar">
        <span className="rp-title">{t("rightPanel.title")}</span>
        {onClose && (
          <button className="rp-close" onClick={onClose} title={t("common.close")}>
            <X aria-hidden="true" />
          </button>
        )}
      </div>
      {hasSession && hasTasks && (
        <section className="rp-section">
          <button
            className="rp-head"
            onClick={() => setProgressOpen((v) => !v)}
          >
            <span className="rp-caret">
              {progressOpen
                ? <ChevronDown aria-hidden="true" />
                : <ChevronRight aria-hidden="true" />}
            </span>
            <span>{t("rightPanel.tasks")}</span>
            <span className="rp-count">{todos.length}</span>
          </button>
          {progressOpen && (
            <ul className="rp-tasks">
              {todos.map((t, i) => {
                const StatusIcon = t.status === "completed"
                  ? CheckCircle2
                  : t.status === "in_progress"
                    ? CircleDotDashed
                    : Circle;
                return (
                  <li key={i} className={`rp-task ${t.status}`}>
                    <StatusIcon className="rp-task-icon" aria-hidden="true" />
                    <span className="rp-task-label">{t.content}</span>
                  </li>
                );
              })}
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
            <span className="rp-caret">
              {artifactsOpen
                ? <ChevronDown aria-hidden="true" />
                : <ChevronRight aria-hidden="true" />}
            </span>
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
              <RefreshCw aria-hidden="true" />
            </span>
            <span
              className="rp-open-folder"
              role="button"
              title={t("rightPanel.showInFinder")}
              onClick={(e) => {
                e.stopPropagation();
                if (artifacts[0]) {
                  window.deepwork.artifacts.reveal(sessionId!, artifacts[0].absolutePath);
                }
              }}
            >
              <FolderOpen aria-hidden="true" />
            </span>
          </button>
          {artifactsOpen && (
            <>
              {hasArtifacts ? (
                <ul className="rp-artifacts" ref={listRef}>
                  {artifacts.map((a) => {
                    const ArtifactIcon = ICONS[a.ext] ?? File;
                    return (
                      <li key={a.absolutePath} className="rp-artifact" data-path={a.absolutePath}>
                        <div className="rp-artifact-main">
                          <ArtifactIcon className="rp-artifact-icon" aria-hidden="true" />
                          <div className="rp-artifact-meta">
                            <div className="rp-artifact-name" title={a.relativePath}>
                              {a.name}
                            </div>
                            <div className="rp-artifact-sub">
                              {formatBytes(a.size)} · {timeLabel(a.modifiedAt)}
                            </div>
                          </div>
                        </div>
                        <button
                          className="rp-artifact-open"
                          onClick={() => window.deepwork.artifacts.open(sessionId!, a.absolutePath)}
                          title={t("rightPanel.open")}
                        >
                          {t("rightPanel.open")}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="rp-empty">{t("rightPanel.emptyArtifacts")}</p>
              )}
            </>
          )}
        </section>
      )}
    </aside>
  );
}
