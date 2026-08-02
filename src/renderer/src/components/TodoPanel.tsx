import type { TodoItem } from "../../../shared/types";

interface Props {
  todos: TodoItem[];
  completed: number;
}

export function TodoPanel({ todos, completed }: Props): React.ReactElement {
  const pct = todos.length ? Math.round((completed / todos.length) * 100) : 0;
  return (
    <div className="todo-panel">
      <div className="todo-head">
        <span>Plan</span>
        <span className="todo-count">
          {completed}/{todos.length}
        </span>
      </div>
      <div className="todo-bar">
        <div className="todo-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <ul className="todo-list">
        {todos.map((t, i) => (
          <li key={i} className={`todo-item ${t.status}`}>
            <span className="todo-mark">
              {t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○"}
            </span>
            <span className="todo-text">{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
