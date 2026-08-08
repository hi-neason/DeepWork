import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AutomationWithRuns, Session, SessionSort } from "../../../shared/types";

export type ViewKey = "chat" | "settings";

/** Storage sentinel for sessions with no explicit group. Kept untranslated in
 * storage; the UI shows a localized label via sidebar.defaultGroup. */
const DEFAULT_GROUP = "默认";

interface Props {
  sessions: Session[];
  activeId: string | null;
  activeView: ViewKey;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onOpenView: (view: ViewKey) => void;
  onMoveToGroup: (id: string, group: string) => void;
  onRenameGroup: (oldName: string, newName: string) => void;
  onDeleteGroup: (name: string) => void;
  onCreateGroup: (name: string) => void;
}

interface MenuState {
  kind: "session" | "group" | "header";
  target: string;
  x: number;
  y: number;
}

export function Sidebar({
  sessions,
  activeId,
  activeView,
  onNew,
  onSelect,
  onDelete,
  onRename,
  onOpenView,
  onMoveToGroup,
  onRenameGroup,
  onDeleteGroup,
  onCreateGroup,
}: Props): React.ReactElement {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editingSession, setEditingSession] = useState<string | null>(null);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SessionSort>("recent");
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<"chats" | "automations">("chats");
  const [automations, setAutomations] = useState<AutomationWithRuns[]>([]);
  const [autoCollapsed, setAutoCollapsed] = useState<Set<string>>(new Set());
  const editRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    if (editingSession || editingGroup) editRef.current?.focus();
  }, [editingSession, editingGroup]);

  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const refreshAutomations = async (): Promise<void> => {
    try {
      setAutomations(await window.deepwork.automations.listWithRuns());
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void refreshAutomations();
    const timer = setInterval(() => void refreshAutomations(), 10_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (section === "automations") void refreshAutomations();
  }, [section]);

  const groups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, Session[]>();
    const q = query.trim().toLowerCase();
    const filtered = q
      ? sessions.filter((s) => s.title.toLowerCase().includes(q))
      : sessions;
    const sorted = [...filtered].sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title);
      if (sort === "created") return b.createdAt - a.createdAt;
      return b.updatedAt - a.updatedAt;
    });
    for (const s of sorted) {
      const g = s.group || DEFAULT_GROUP;
      if (!map.has(g)) {
        map.set(g, []);
        order.push(g);
      }
      map.get(g)!.push(s);
    }
    // Default group always first.
    order.sort((a, b) => {
      if (a === DEFAULT_GROUP) return -1;
      if (b === DEFAULT_GROUP) return 1;
      return a.localeCompare(b);
    });
    return order.map((name) => ({ name, sessions: map.get(name)! }));
  }, [sessions, sort, query]);

  const allCollapsed = groups.every((g) => collapsed.has(g.name));

  const toggleAll = (): void => {
    if (allCollapsed) setCollapsed(new Set());
    else setCollapsed(new Set(groups.map((g) => g.name)));
  };

  const toggleGroup = (name: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const startRenameSession = (s: Session): void => {
    setMenu(null);
    setEditingSession(s.id);
    setDraft(s.title);
  };

  const commitSession = (id: string): void => {
    const title = draft.trim();
    if (title) onRename(id, title);
    setEditingSession(null);
    setDraft("");
  };

  const startRenameGroup = (name: string): void => {
    setMenu(null);
    setEditingGroup(name);
    setDraft(name);
  };

  const commitGroup = (oldName: string): void => {
    const name = draft.trim();
    if (name && name !== oldName) onRenameGroup(oldName, name);
    setEditingGroup(null);
    setDraft("");
  };

  return (
    <aside className="sidebar">
      <h1>DeepWork</h1>

      <nav className="nav">
        <div
          className={`nav-item ${activeView === "chat" ? "active" : ""}`}
          onClick={() => {
            onNew();
            onOpenView("chat");
          }}
        >
              <span className="nav-icon">✚</span>
          <span>{t("sidebar.newTask")}</span>
        </div>
      </nav>

      <div className="task-section">
        <div className="section-tabs">
          <button
            className={`section-tab ${section === "chats" ? "active" : ""}`}
            onClick={() => setSection("chats")}
          >
            {t("sidebar.taskList")}
          </button>
          <button
            className={`section-tab ${section === "automations" ? "active" : ""}`}
            onClick={() => setSection("automations")}
          >
            {t("sidebar.automations")}
          </button>
        </div>
        {section === "chats" && (
          <>
            <div className="task-header">
              <span>{t("sidebar.taskList")}</span>
              <div className="task-header-actions">
                <button
                  className="icon-btn"
                  title={allCollapsed ? t("sidebar.expandAll") : t("sidebar.collapseAll")}
                  onClick={toggleAll}
                >
                  {allCollapsed ? "⤢" : "⤡"}
                </button>
                <button
                  className="icon-btn"
                  title={t("sidebar.sortFilter")}
                  onClick={(e) =>
                    setMenu({ kind: "header", target: "", x: e.clientX, y: e.clientY })
                  }
                >
                  ☰
                </button>
              </div>
            </div>
            <input
              className="task-search"
              placeholder={t("sidebar.searchTasks")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </>
        )}
      </div>

      <div className="session-scroll">
        {section === "chats" ? (
          groups.map((g) => (
            <div key={g.name} className="group">
              <div
                className="group-head"
                onClick={() => toggleGroup(g.name)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ kind: "group", target: g.name, x: e.clientX, y: e.clientY });
                }}
              >
                <span className="group-caret">{collapsed.has(g.name) ? "▸" : "▾"}</span>
                {editingGroup === g.name ? (
                  <input
                    ref={editRef}
                    className="rename-input"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => commitGroup(g.name)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") commitGroup(g.name);
                      if (e.key === "Escape") {
                        setEditingGroup(null);
                        setDraft("");
                      }
                    }}
                  />
                ) : (
                  <span className="group-name">
                    <span className="group-folder">📁</span> {g.name === DEFAULT_GROUP ? t("sidebar.defaultGroup") : g.name}
                  </span>
                )}
                <span className="group-count">{g.sessions.length}</span>
              </div>

              {!collapsed.has(g.name) &&
                g.sessions.map((s) => (
                  <div
                    key={s.id}
                    className={`session-item ${s.id === activeId && activeView === "chat" ? "active" : ""}`}
                    onClick={() => onSelect(s.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      onSelect(s.id);
                      setMenu({ kind: "session", target: s.id, x: e.clientX, y: e.clientY });
                    }}
                  >
                    {editingSession === s.id ? (
                      <input
                        ref={editRef}
                        className="rename-input"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={() => commitSession(s.id)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") commitSession(s.id);
                          if (e.key === "Escape") {
                            setEditingSession(null);
                            setDraft("");
                          }
                        }}
                      />
                    ) : (
                      <span className="session-title">{s.title}</span>
                    )}
                    <span
                      className="del"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(s.id);
                      }}
                    >
                      ✕
                    </span>
                  </div>
                ))}
            </div>
          ))
        ) : (
          <AutomationList
            items={automations}
            activeId={activeId}
            collapsed={autoCollapsed}
            onToggle={(id) =>
              setAutoCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onSelectRun={onSelect}
          />
        )}
      </div>

      <div className="sidebar-footer">
        <div
          className={`settings-footer-item ${activeView === "settings" ? "active" : ""}`}
          onClick={() => onOpenView("settings")}
        >
          <span className="nav-icon">⚙</span>
          <span>{t("sidebar.settings")}</span>
        </div>
      </div>

      {menu && (
        <div
          className="ctx-menu"
          style={{ top: menu.y, left: menu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.kind === "session" && (
            <>
              <div
                className="ctx-item"
                onClick={() => {
                  const s = sessions.find((x) => x.id === menu.target);
                  if (s) startRenameSession(s);
                }}
              >
                {t("sidebar.rename")}
              </div>
              <div className="ctx-sub">
                <div className="ctx-item">{t("sidebar.moveTo")}</div>
                <div className="ctx-submenu">
                  {groups.map((g) => (
                    <div
                      key={g.name}
                      className="ctx-item"
                      onClick={() => {
                        onMoveToGroup(menu.target, g.name);
                        setMenu(null);
                      }}
                    >
                      {g.name === DEFAULT_GROUP ? t("sidebar.defaultGroup") : g.name}
                    </div>
                  ))}
                  <div
                    className="ctx-item"
                    onClick={() => {
                      const name = prompt(t("sidebar.newGroup"));
                      if (name?.trim()) {
                        onCreateGroup(name.trim());
                        onMoveToGroup(menu.target, name.trim());
                      }
                      setMenu(null);
                    }}
                  >
                    {t("sidebar.newGroup")}
                  </div>
                </div>
              </div>
              <div
                className="ctx-item danger"
                onClick={() => {
                  onDelete(menu.target);
                  setMenu(null);
                }}
              >
                {t("sidebar.delete")}
              </div>
            </>
          )}
          {menu.kind === "group" && (
            <>
              <div className="ctx-item" onClick={() => startRenameGroup(menu.target)}>
                {t("sidebar.renameGroup")}
              </div>
              {menu.target !== DEFAULT_GROUP && (
                <div
                  className="ctx-item danger"
                  onClick={() => {
                    onDeleteGroup(menu.target);
                    setMenu(null);
                  }}
                >
                  {t("sidebar.deleteGroup")}
                </div>
              )}
            </>
          )}
          {menu.kind === "header" && (
            <>
              <div className="ctx-label">{t("sidebar.sortBy")}</div>
              {(["recent", "title", "created"] as SessionSort[]).map((s) => (
                <div
                  key={s}
                  className={`ctx-item ${sort === s ? "checked" : ""}`}
                  onClick={() => {
                    setSort(s);
                    setMenu(null);
                  }}
                >
                  {s === "recent" ? t("sidebar.sortRecent") : s === "created" ? t("sidebar.sortCreated") : t("sidebar.sortTitle")}
                </div>
              ))}
              <div className="ctx-sep" />
              <div
                className="ctx-item"
                onClick={() => {
                  const name = prompt(t("sidebar.newGroup"));
                  if (name?.trim()) onCreateGroup(name.trim());
                  setMenu(null);
                }}
              >
                {t("sidebar.newGroup")}
              </div>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

interface AutomationListProps {
  items: AutomationWithRuns[];
  activeId: string | null;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onSelectRun: (sessionId: string) => void;
}

function AutomationList({ items, activeId, collapsed, onToggle, onSelectRun }: AutomationListProps): React.ReactElement {
  const { t } = useTranslation();
  if (items.length === 0) {
    return <p className="auto-empty">{t("sidebar.noAutomations")}</p>;
  }
  return (
    <div className="auto-group-list">
      {items.map((a) => (
        <div key={a.id} className="group">
          <div className="group-head" onClick={() => onToggle(a.id)}>
            <span className="group-caret">{collapsed.has(a.id) ? "▸" : "▾"}</span>
            <span className="group-name">
              <span className="group-folder">⏰</span> {a.title}
            </span>
            <span className="group-count">{a.runs.length}</span>
          </div>
          {!collapsed.has(a.id) && (
            <div className="auto-runs">
              {a.runs.length === 0 && (
                <div className="auto-no-runs">{t("sidebar.noAutomationRuns")}</div>
              )}
              {a.runs.map((r) => (
                <div
                  key={r.id}
                  className={`session-item ${r.sessionId === activeId ? "active" : ""}`}
                  onClick={() => r.sessionId && onSelectRun(r.sessionId)}
                >
                  <span className="session-title">{formatRunTime(r.startedAt)}</span>
                  <span className={`auto-run-status ${statusClass(r.status)}`} title={r.error || r.status} />
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function formatRunTime(ts: number): string {
  const d = new Date(ts);
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${m}-${day} ${hh}:${mm}`;
}

function statusClass(s?: string): string {
  if (s === "success") return "ok";
  if (s === "error") return "danger";
  if (s === "running") return "accent";
  return "";
}
