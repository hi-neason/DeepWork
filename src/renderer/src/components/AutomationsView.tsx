import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Automation } from "../../../shared/types";

interface Props {
  onClose: () => void;
}

const PRESETS: { label: string; labelKey: string; schedule: string }[] = [
  { label: "Every day at 9:00", labelKey: "automations.presetDaily", schedule: "0 9 * * *" },
  { label: "Every weekday at 9:00", labelKey: "automations.presetWeekday", schedule: "0 9 * * 1-5" },
  { label: "Every Monday at 9:00", labelKey: "automations.presetMonday", schedule: "0 9 * * 1" },
  { label: "Every hour", labelKey: "automations.presetHour", schedule: "0 * * * *" },
];

export function AutomationsView({ onClose }: Props): React.ReactElement {
  const { t } = useTranslation();
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
        <h2>{t("automations.title")}</h2>
        <button className="btn" onClick={onClose}>
          {t("common.close")}
        </button>
      </div>
      <p style={{ color: "var(--text-dim)", fontSize: 13, marginTop: -4 }}>
        {t("automations.intro")}
      </p>

      {items.length === 0 && !showForm && (
        <p style={{ color: "var(--text-dim)" }}>{t("automations.empty")}</p>
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
                {running === a.id ? t("automations.running") : t("automations.runNow")}
              </button>
              <button className="btn danger small" onClick={() => remove(a.id)}>
                {t("common.delete")}
              </button>
            </div>
          </div>
          <div className="auto-instructions">{a.instructions}</div>
          <div className="auto-meta">
            <code>{a.schedule}</code>
            {a.lastStatus && (
              <span className={`auto-status ${a.lastStatus}`}>{t("automations.last", { status: a.lastStatus })}</span>
            )}
          </div>
        </div>
      ))}

      {showForm ? (
        <div className="auto-form">
          <div className="field">
            <label>{t("automations.titleLabel")}</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("automations.titlePlaceholder")} />
          </div>
          <div className="field">
            <label>{t("automations.instructionsLabel")}</label>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={4}
              placeholder={t("automations.instructionsPlaceholder")}
            />
          </div>
          <div className="field">
            <label>{t("automations.scheduleLabel")}</label>
            <input value={schedule} onChange={(e) => setSchedule(e.target.value)} />
            <div className="presets">
              {PRESETS.map((p) => (
                <button key={p.schedule} className="btn small" onClick={() => setSchedule(p.schedule)}>
                  {t(p.labelKey)}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary" onClick={create}>
              {t("common.create")}
            </button>
            <button className="btn" onClick={() => setShowForm(false)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <button className="btn" style={{ marginTop: 12 }} onClick={() => setShowForm(true)}>
          {t("automations.new")}
        </button>
      )}
    </div>
  );
}
