import { useEffect, useRef, useState } from "react";
import type { Session } from "../../../shared/types";

interface Props {
  sessions: Session[];
  activeId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onOpenSettings: () => void;
}

interface MenuState {
  id: string;
  x: number;
  y: number;
}

export function Sidebar({
  sessions,
  activeId,
  onNew,
  onSelect,
  onDelete,
  onRename,
  onOpenSettings,
}: Props): React.ReactElement {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);

  // Close the context menu on any outside click / escape.
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

  const startRename = (s: Session): void => {
    setMenu(null);
    setEditing(s.id);
    setDraft(s.title);
  };

  const commitRename = (id: string): void => {
    const title = draft.trim();
    if (title) onRename(id, title);
    setEditing(null);
    setDraft("");
  };

  return (
    <aside className="sidebar">
      <h1>DeepWork</h1>
      <button className="new-chat" onClick={onNew}>
        + New chat
      </button>
      <div style={{ overflowY: "auto", flex: 1, marginTop: 6 }}>
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`session-item ${s.id === activeId ? "active" : ""}`}
            onClick={() => editing !== s.id && onSelect(s.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              onSelect(s.id);
              setMenu({ id: s.id, x: e.clientX, y: e.clientY });
            }}
          >
            {editing === s.id ? (
              <input
                ref={editRef}
                className="rename-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => commitRename(s.id)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") commitRename(s.id);
                  if (e.key === "Escape") {
                    setEditing(null);
                    setDraft("");
                  }
                }}
              />
            ) : (
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{s.title}</span>
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

      {menu && (
        <div
          className="ctx-menu"
          style={{ top: menu.y, left: menu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="ctx-item"
            onClick={() => {
              const s = sessions.find((x) => x.id === menu.id);
              if (s) startRename(s);
            }}
          >
            Rename
          </div>
          <div
            className="ctx-item danger"
            onClick={() => {
              onDelete(menu.id);
              setMenu(null);
            }}
          >
            Delete
          </div>
        </div>
      )}

      <div className="sidebar-footer">
        <div className="session-item" onClick={onOpenSettings}>
          ⚙ Settings
        </div>
      </div>
    </aside>
  );
}
