import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AutomationWithRuns, Session, SessionSort } from "../../../shared/types";
import {
  ChevronDown,
  ChevronRight,
  Clock3,
  Folder,
  Plus,
  Settings2,
  Timer,
  Trash2,
  X,
} from "lucide-react";

export type ViewKey = "chat" | "settings";

/** Storage sentinel for sessions with no explicit group. Must match
 * DEFAULT_GROUP in src/main/storage/sessions.ts. The UI shows a localized
 * label via sidebar.defaultGroup; this id itself stays language-neutral. */
const DEFAULT_GROUP = "Default";

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
  const [autoQuery, setAutoQuery] = useState("");
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

  const handleDeleteRun = async (runId: string): Promise<void> => {
    if (!window.confirm(t("sidebar.confirmDeleteRun"))) return;
    try {
      await window.deepwork.automations.deleteRun(runId);
      await refreshAutomations();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteRuns = async (automationId: string): Promise<void> => {
    if (!window.confirm(t("sidebar.confirmClearRuns"))) return;
    try {
      await window.deepwork.automations.deleteRuns(automationId);
      await refreshAutomations();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
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

  const filteredAutomations = useMemo(() => {
    const q = autoQuery.trim().toLowerCase();
    if (!q) return automations;
    return automations.filter((a) => {
      const haystack = [
        a.title,
        ...a.runs.flatMap((r) => [
          formatRunTime(r.startedAt),
          r.status,
          r.error ?? "",
        ]),
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [automations, autoQuery]);

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

      <nav className="nav" aria-label={t("sidebar.primaryNavigation")}>
        <button
          type="button"
          className={`nav-item ${activeView === "chat" ? "active" : ""}`}
          onClick={() => {
            onNew();
            onOpenView("chat");
          }}
        >
          <Plus className="nav-icon" aria-hidden="true" />
          <span>{t("sidebar.newTask")}</span>
        </button>
      </nav>

      <div className="task-section">
        <div className="section-tabs" role="tablist" aria-label={t("sidebar.taskViews")}>
          <button
            className={`section-tab ${section === "chats" ? "active" : ""}`}
            onClick={() => setSection("chats")}
            role="tab"
            aria-selected={section === "chats"}
          >
            {t("sidebar.taskList")}
          </button>
          <button
            className={`section-tab ${section === "automations" ? "active" : ""}`}
            onClick={() => setSection("automations")}
            role="tab"
            aria-selected={section === "automations"}
          >
            {t("sidebar.automations")}
          </button>
        </div>
        {section === "chats" && (
          <input
            className="task-search"
            placeholder={t("sidebar.searchTasks")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        {section === "automations" && (
          <input
            className="task-search"
            placeholder={t("sidebar.searchAutomations")}
            value={autoQuery}
            onChange={(e) => setAutoQuery(e.target.value)}
          />
        )}
      </div>

      <div className="session-scroll">
        {section === "chats" ? (
          <div className="sidebar-chat-list">
            {groups.map((g) => (
              <div key={g.name} className="sidebar-chat-card">
                <div
                  className="sidebar-chat-head"
                  onClick={() => toggleGroup(g.name)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ kind: "group", target: g.name, x: e.clientX, y: e.clientY });
                  }}
                >
                  <span className="sidebar-chat-caret">
                    {collapsed.has(g.name)
                      ? <ChevronRight aria-hidden="true" />
                      : <ChevronDown aria-hidden="true" />}
                  </span>
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
                    <span className="sidebar-chat-group-name">
                      <Folder className="sidebar-chat-icon" aria-hidden="true" />
                      <span className="sidebar-chat-group-title">
                        {g.name === DEFAULT_GROUP ? t("sidebar.defaultGroup") : g.name}
                      </span>
                    </span>
                  )}
                  <span className="sidebar-chat-count">{g.sessions.length}</span>
                </div>

                {!collapsed.has(g.name) &&
                  g.sessions.map((s) => (
                    <div
                      key={s.id}
                      className={`sidebar-chat-session ${s.id === activeId && activeView === "chat" ? "active" : ""}`}
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
                        <span className="sidebar-chat-session-title">{s.title}</span>
                      )}
                      <button
                        type="button"
                        className="sidebar-chat-delete"
                        aria-label={`${t("sidebar.delete")} ${s.title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(s.id);
                        }}
                      >
                        <X aria-hidden="true" />
                      </button>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        ) : (
          <AutomationList
            items={filteredAutomations}
            isFiltering={autoQuery.trim().length > 0}
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
            onDeleteRun={handleDeleteRun}
            onDeleteRuns={handleDeleteRuns}
          />
        )}
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className={`settings-footer-item ${activeView === "settings" ? "active" : ""}`}
          onClick={() => onOpenView("settings")}
        >
          <Settings2 className="nav-icon" aria-hidden="true" />
          <span>{t("sidebar.settings")}</span>
        </button>
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
  isFiltering: boolean;
  activeId: string | null;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onSelectRun: (sessionId: string) => void;
  onDeleteRun: (runId: string) => void;
  onDeleteRuns: (automationId: string) => void;
}

function AutomationList({
  items,
  isFiltering,
  activeId,
  collapsed,
  onToggle,
  onSelectRun,
  onDeleteRun,
  onDeleteRuns,
}: AutomationListProps): React.ReactElement {
  const { t } = useTranslation();
  if (items.length === 0) {
    return (
      <div className="sidebar-auto-empty">
        <Timer className="sidebar-auto-empty-icon" aria-hidden="true" />
        <span>{t(isFiltering ? "sidebar.noAutomationMatches" : "sidebar.noAutomations")}</span>
      </div>
    );
  }
  return (
    <div className="sidebar-auto-list">
      {items.map((a) => (
        <div key={a.id} className="sidebar-auto-card">
          <div
            className="sidebar-auto-head"
            onClick={() => onToggle(a.id)}
          >
            <span className="sidebar-auto-caret">
              {collapsed.has(a.id)
                ? <ChevronRight aria-hidden="true" />
                : <ChevronDown aria-hidden="true" />}
            </span>
            <Clock3 className="sidebar-auto-icon" aria-hidden="true" />
            <span className="sidebar-auto-title">
              {a.title}
            </span>
            <span className="sidebar-auto-count">{a.runs.length}</span>
            {a.runs.length > 0 && (
              <button
                type="button"
                className="sidebar-auto-clear"
                title={t("sidebar.clearRuns")}
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteRuns(a.id);
                }}
              >
                <Trash2 aria-hidden="true" />
              </button>
            )}
          </div>
          {!collapsed.has(a.id) && (
            <div className="sidebar-auto-runs">
              {a.runs.length === 0 && (
                <div className="sidebar-auto-no-runs">{t("sidebar.noAutomationRuns")}</div>
              )}
              {a.runs.map((r) => (
                <div
                  key={r.id}
                  className={`sidebar-auto-run ${r.sessionId === activeId ? "active" : ""}`}
                  onClick={() => r.sessionId && onSelectRun(r.sessionId)}
                >
                  <span className="sidebar-auto-run-title">{formatRunTime(r.startedAt)}</span>
                  <span className={`sidebar-auto-run-status ${statusClass(r.status)}`} title={r.error || r.status} />
                  <button
                    type="button"
                    className="sidebar-auto-run-delete"
                    title={t("sidebar.deleteRun")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteRun(r.id);
                    }}
                  >
                    <X aria-hidden="true" />
                  </button>
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
