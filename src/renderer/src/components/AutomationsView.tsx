import { useEffect, useState } from "react";
import type { Automation } from "../../../shared/types";

interface Props {
  onClose: () => void;
}

const PRESETS: { label: string; schedule: string }[] = [
  { label: "Every day at 9:00", schedule: "0 9 * * *" },
  { label: "Every weekday at 9:00", schedule: "0 9 * * 1-5" },
  { label: "Every Monday at 9:00", schedule: "0 9 * * 1" },
  { label: "Every hour", schedule: "0 * * * *" },
];

export function AutomationsView({ onClose }: Props): React.ReactElement {
  const [items, setItems] = useState<Automation[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [schedule, setSchedule] = useState("0 9 * * *");
  const [running, setRunning] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    setItems(await window.deepwork.automations.list());
  };

  useEffect(() => {
    void refresh();
  }, []);

  const create = async (): Promise<void> => {
    if (!title.trim() || !instructions.trim()) return;
    await window.deepwork.automations.create({
      title: title.trim(),
      instructions: instructions.trim(),
      schedule,
    });
    setTitle("");
    setInstructions("");
    setShowForm(false);
    void refresh();
  };

  const toggle = async (a: Automation): Promise<void> => {
    await window.deepwork.automations.update(a.id, { enabled: !a.enabled });
    void refresh();
  };

  const remove = async (id: string): Promise<void> => {
    await window.deepwork.automations.delete(id);
    void refresh();
  };

  const runNow = async (id: string): Promise<void> => {
    setRunning(id);
    try {
      await window.deepwork.automations.runNow(id);
    } finally {
      setRunning(null);
      void refresh();
    }
  };

  return (
    <div className="settings">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Automations</h2>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
      <p style={{ color: "var(--text-dim)", fontSize: 13, marginTop: -4 }}>
        Run a task on a schedule. Each run creates its own chat session; approvals are parked
        until you return.
      </p>

      {items.length === 0 && !showForm && (
        <p style={{ color: "var(--text-dim)" }}>No automations yet.</p>
      )}

      {items.map((a) => (
        <div key={a.id} className="auto-card">
          <div className="auto-head">
            <label className="switch">
              <input type="checkbox" checked={a.enabled} onChange={() => toggle(a)} />
              <span>{a.title}</span>
            </label>
            <div className="auto-actions">
              <button className="btn small" onClick={() => runNow(a.id)} disabled={running === a.id}>
                {running === a.id ? "Running…" : "Run now"}
              </button>
              <button className="btn danger small" onClick={() => remove(a.id)}>
                Delete
              </button>
            </div>
          </div>
          <div className="auto-instructions">{a.instructions}</div>
          <div className="auto-meta">
            <code>{a.schedule}</code>
            {a.lastStatus && (
              <span className={`auto-status ${a.lastStatus}`}>last: {a.lastStatus}</span>
            )}
          </div>
        </div>
      ))}

      {showForm ? (
        <div className="auto-form">
          <div className="field">
            <label>Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Morning brief" />
          </div>
          <div className="field">
            <label>Instructions</label>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={4}
              placeholder="Summarize unread GitHub notifications and prepare a short standup note."
            />
          </div>
          <div className="field">
            <label>Schedule (cron: minute hour day month weekday)</label>
            <input value={schedule} onChange={(e) => setSchedule(e.target.value)} />
            <div className="presets">
              {PRESETS.map((p) => (
                <button key={p.schedule} className="btn small" onClick={() => setSchedule(p.schedule)}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary" onClick={create}>
              Create
            </button>
            <button className="btn" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="btn" style={{ marginTop: 12 }} onClick={() => setShowForm(true)}>
          + New automation
        </button>
      )}
    </div>
  );
}
