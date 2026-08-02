import type { Session } from "../../../shared/types";

interface Props {
  sessions: Session[];
  activeId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
}

export function Sidebar({ sessions, activeId, onNew, onSelect, onDelete, onOpenSettings }: Props): React.ReactElement {
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
            onClick={() => onSelect(s.id)}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{s.title}</span>
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
      <div className="sidebar-footer">
        <div className="session-item" onClick={onOpenSettings}>
          ⚙ Settings
        </div>
      </div>
    </aside>
  );
}
