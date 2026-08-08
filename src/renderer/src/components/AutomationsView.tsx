import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  Automation,
  AutomationRun,
  AutomationScheduleConfig,
  PermissionMode,
  ScheduleType,
} from "../../../shared/types";

const WEEK_DAYS = [
  { key: 0, label: "日" },
  { key: 1, label: "一" },
  { key: 2, label: "二" },
  { key: 3, label: "三" },
  { key: 4, label: "四" },
  { key: 5, label: "五" },
  { key: 6, label: "六" },
];

const PRESET_CRONS = [
  { label: "每天 9:00", scheduleType: "cron" as ScheduleType, cron: "0 9 * * *" },
  { label: "每个工作日 9:00", scheduleType: "cron" as ScheduleType, cron: "0 9 * * 1-5" },
  { label: "每周一 9:00", scheduleType: "cron" as ScheduleType, cron: "0 9 * * 1" },
  { label: "每小时", scheduleType: "cron" as ScheduleType, cron: "0 * * * *" },
];

function formatTime(d = new Date()): string {
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function basename(p?: string): string {
  if (!p) return "";
  const s = p.replace(/[/\\]+$/, "");
  const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return s.slice(idx + 1) || s;
}

function describeAutomation(a: Automation, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const cfg = a.scheduleConfig || {};
  switch (a.scheduleType) {
    case "daily":
      return t("automations.desc.daily", { time: cfg.time || "--:--" });
    case "weekly": {
      const days = cfg.days ?? [];
      const names = days.map((d) => t("automations.weekDayShort", { n: d })).join(", ");
      return t("automations.desc.weekly", { days: names || t("automations.noDays"), time: cfg.time || "--:--" });
    }
    case "cron":
      return t("automations.desc.cron", { expr: cfg.cron || a.schedule || "-" });
    case "once":
      return t("automations.desc.once", { datetime: cfg.datetime || a.runAt || "-" });
    default:
      return a.schedule || "-";
  }
}

function statusClass(s?: AutomationRun["status"]): string {
  if (!s) return "";
  if (s === "success") return "ok";
  if (s === "error") return "danger";
  if (s === "running") return "accent";
  return "";
}

interface FormState {
  title: string;
  workspaceDir: string;
  instructions: string;
  scheduleType: ScheduleType;
  time: string;
  days: number[];
  cron: string;
  onceDate: string;
  onceTime: string;
  validFrom: string;
  validUntil: string;
  permissionMode: PermissionMode;
  skills: string[];
  mcpServerIds: string[];
}

function emptyForm(): FormState {
  return {
    title: "",
    workspaceDir: "",
    instructions: "",
    scheduleType: "daily",
    time: "09:00",
    days: [1, 2, 3, 4, 5],
    cron: "0 9 * * *",
    onceDate: formatDate(),
    onceTime: formatTime(),
    validFrom: "",
    validUntil: "",
    permissionMode: "auto",
    skills: [],
    mcpServerIds: [],
  };
}

function formFromAutomation(a: Automation): FormState {
  const cfg = a.scheduleConfig || {};
  let onceDate = formatDate();
  let onceTime = "09:00";
  if (cfg.datetime || a.runAt) {
    const d = new Date(cfg.datetime || a.runAt || Date.now());
    onceDate = formatDate(d);
    onceTime = formatTime(d);
  }
  const legacySchedule = a.schedule && a.schedule !== "once" ? a.schedule : "";
  return {
    title: a.title,
    workspaceDir: a.workspaceDir || "",
    instructions: a.instructions,
    scheduleType: a.scheduleType || "daily",
    time: cfg.time || "09:00",
    days: cfg.days ?? [1, 2, 3, 4, 5],
    cron: cfg.cron || legacySchedule || "0 9 * * *",
    onceDate,
    onceTime,
    validFrom: a.validFrom || "",
    validUntil: a.validUntil || "",
    permissionMode: a.permissionMode || "auto",
    skills: a.skills || [],
    mcpServerIds: a.mcpServerIds || [],
  };
}

function buildScheduleConfig(f: FormState): AutomationScheduleConfig {
  switch (f.scheduleType) {
    case "daily":
      return { time: f.time };
    case "weekly":
      return { time: f.time, days: [...f.days].sort((a, b) => a - b) };
    case "cron":
      return { cron: f.cron.trim() };
    case "once": {
      const dt = new Date(`${f.onceDate}T${f.onceTime}`);
      return { datetime: dt.toISOString() };
    }
    default:
      return {};
  }
}

export function AutomationsView(): React.ReactElement {
  const { t } = useTranslation();
  const [items, setItems] = useState<Automation[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mcpServers, setMcpServers] = useState<{ id: string; label: string }[]>([]);
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([]);

  const refresh = async (): Promise<void> => {
    setItems(await window.deepwork.automations.list());
  };

  useEffect(() => {
    void refresh();
    void loadExtras();
  }, []);

  const loadExtras = async (): Promise<void> => {
    try {
      const settings = await window.deepwork.settings.get();
      setMcpServers(settings.mcpServers.filter((s) => s.enabled).map((s) => ({ id: s.id, label: s.label })));
    } catch {
      // ignore
    }
    try {
      const list = await window.deepwork.skills.list();
      setSkills(list.filter((s) => s.enabled).map((s) => ({ name: s.name, description: s.description })));
    } catch {
      // ignore
    }
  };

  const openCreate = (): void => {
    setEditingId(null);
    setForm(emptyForm());
    setShowForm(true);
  };

  const openEdit = (a: Automation): void => {
    setEditingId(a.id);
    setForm(formFromAutomation(a));
    setShowForm(true);
  };

  const closeForm = (): void => {
    setShowForm(false);
    setEditingId(null);
  };

  const pickWorkspace = async (): Promise<void> => {
    const dir = await window.deepwork.settings.pickDirectory();
    if (dir) setForm((f) => ({ ...f, workspaceDir: dir }));
  };

  const save = async (): Promise<void> => {
    const title = form.title.trim();
    const instructions = form.instructions.trim();
    if (!title || !instructions) return;
    setBusy(true);
    const payload: Omit<Automation, "id" | "createdAt" | "updatedAt" | "enabled" | "lastRunAt" | "lastStatus"> = {
      title,
      instructions,
      workspaceDir: form.workspaceDir || undefined,
      scheduleType: form.scheduleType,
      scheduleConfig: buildScheduleConfig(form),
      validFrom: form.validFrom || undefined,
      validUntil: form.validUntil || undefined,
      permissionMode: form.permissionMode,
      skills: form.skills.length ? form.skills : undefined,
      mcpServerIds: form.mcpServerIds.length ? form.mcpServerIds : undefined,
    };
    try {
      if (editingId) {
        await window.deepwork.automations.update(editingId, payload);
      } else {
        await window.deepwork.automations.create(payload);
      }
      closeForm();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (a: Automation): Promise<void> => {
    await window.deepwork.automations.update(a.id, { enabled: !a.enabled });
    await refresh();
  };

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm(t("automations.confirmDelete"))) return;
    await window.deepwork.automations.delete(id);
    await refresh();
  };

  const runNow = async (id: string): Promise<void> => {
    setRunningId(id);
    try {
      await window.deepwork.automations.runNow(id);
    } finally {
      setRunningId(null);
      await refresh();
    }
  };

  const toggleDay = (day: number): void => {
    setForm((f) => {
      const days = f.days.includes(day) ? f.days.filter((d) => d !== day) : [...f.days, day];
      return { ...f, days };
    });
  };

  const toggleSkill = (name: string): void => {
    setForm((f) => {
      const skills = f.skills.includes(name) ? f.skills.filter((s) => s !== name) : [...f.skills, name];
      return { ...f, skills };
    });
  };

  const toggleMcp = (id: string): void => {
    setForm((f) => {
      const ids = f.mcpServerIds.includes(id) ? f.mcpServerIds.filter((x) => x !== id) : [...f.mcpServerIds, id];
      return { ...f, mcpServerIds: ids };
    });
  };

  const formValid = useMemo(() => {
    if (!form.title.trim() || !form.instructions.trim()) return false;
    if (form.scheduleType === "cron" && !form.cron.trim()) return false;
    if (form.scheduleType === "weekly" && form.days.length === 0) return false;
    return true;
  }, [form]);

  const scheduleTabs: { key: ScheduleType; label: string }[] = [
    { key: "daily", label: t("automations.tab.daily") },
    { key: "weekly", label: t("automations.tab.weekly") },
    { key: "cron", label: t("automations.tab.cron") },
    { key: "once", label: t("automations.tab.once") },
  ];

  return (
    <div className="settings-section">
      <div className="auto-list-header">
        <div>
          <h2>{t("automations.title")}</h2>
          <p className="auto-intro">{t("automations.intro")}</p>
        </div>
        <button className="btn primary" onClick={openCreate}>
          {t("automations.new")}
        </button>
      </div>

      {items.length === 0 && <p className="auto-empty">{t("automations.empty")}</p>}

      <div className="auto-list">
        {items.map((a) => (
          <div key={a.id} className="auto-card">
            <div className="auto-head">
              <label className="switch">
                <input type="checkbox" checked={a.enabled} onChange={() => toggle(a)} />
                <span>{a.title}</span>
              </label>
              <div className="auto-actions">
                <button
                  className="btn small"
                  onClick={() => runNow(a.id)}
                  disabled={runningId === a.id}
                >
                  {runningId === a.id ? t("automations.running") : t("automations.runNow")}
                </button>
                <button className="btn small" onClick={() => openEdit(a)}>
                  {t("common.edit")}
                </button>
                <button className="btn danger small" onClick={() => remove(a.id)}>
                  {t("common.delete")}
                </button>
              </div>
            </div>
            <div className="auto-instructions">{a.instructions}</div>
            <div className="auto-meta">
              <span className="auto-schedule">{describeAutomation(a, t)}</span>
              {a.workspaceDir && (
                <span className="auto-workspace" title={a.workspaceDir}>
                  {basename(a.workspaceDir)}
                </span>
              )}
              {a.lastStatus && (
                <span className={`auto-status ${statusClass(a.lastStatus)}`}>
                  {t("automations.last", { status: t(`automations.status.${a.lastStatus}`) })}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {showForm && (
        <div className="auto-form-panel">
          <div className="auto-form-head">
            <div className="auto-breadcrumb">
              <span>{t("automations.title")}</span>
              <span className="sep">/</span>
              <span>{editingId ? t("automations.editTitle") : t("automations.createTitle")}</span>
            </div>
            <div className="auto-form-actions">
              <button className="btn" onClick={closeForm} disabled={busy}>
                {t("common.cancel")}
              </button>
              <button className="btn primary" onClick={save} disabled={busy || !formValid}>
                {t("common.save")}
              </button>
            </div>
          </div>

          <div className="auto-form-body">
            <div className="auto-banner">
              <span className="auto-banner-icon">ℹ</span>
              <span>{t("automations.banner")}</span>
            </div>

            <div className="auto-field">
              <label>{t("automations.nameLabel")}</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder={t("automations.namePlaceholder")}
              />
            </div>

            <div className="auto-field">
              <label>{t("automations.workspaceLabel")}</label>
              <div className="auto-workspace-picker">
                {form.workspaceDir ? (
                  <span className="auto-workspace-path" title={form.workspaceDir}>
                    {form.workspaceDir}
                  </span>
                ) : (
                  <span className="auto-workspace-empty">{t("automations.workspaceEmpty")}</span>
                )}
                <button className="btn small" onClick={pickWorkspace}>
                  {form.workspaceDir ? t("automations.changeWorkspace") : t("automations.pickWorkspace")}
                </button>
              </div>
            </div>

            <div className="auto-field">
              <label>{t("automations.instructionsLabel")}</label>
              <textarea
                value={form.instructions}
                onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
                rows={6}
                placeholder={t("automations.instructionsPlaceholder")}
              />
            </div>

            <div className="auto-field">
              <label>{t("automations.permissionLabel")}</label>
              <div className="auto-mode-bar">
                {(["auto", "manual", "plan"] as PermissionMode[]).map((m) => (
                  <button
                    key={m}
                    className={`auto-mode-btn ${form.permissionMode === m ? "active" : ""}`}
                    onClick={() => setForm((f) => ({ ...f, permissionMode: m }))}
                  >
                    {t(`automations.mode.${m}`)}
                  </button>
                ))}
              </div>
              <p className="auto-field-hint">{t("automations.permissionHint")}</p>
            </div>

            {skills.length > 0 && (
              <div className="auto-field">
                <label>{t("automations.skillsLabel")}</label>
                <div className="auto-chips">
                  {skills.map((s) => (
                    <label key={s.name} className="auto-chip">
                      <input
                        type="checkbox"
                        checked={form.skills.includes(s.name)}
                        onChange={() => toggleSkill(s.name)}
                      />
                      <span>{s.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {mcpServers.length > 0 && (
              <div className="auto-field">
                <label>{t("automations.mcpLabel")}</label>
                <div className="auto-chips">
                  {mcpServers.map((s) => (
                    <label key={s.id} className="auto-chip">
                      <input
                        type="checkbox"
                        checked={form.mcpServerIds.includes(s.id)}
                        onChange={() => toggleMcp(s.id)}
                      />
                      <span>{s.label || s.id}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="auto-field">
              <label>{t("automations.scheduleLabel")}</label>
              <div className="tabs auto-tabs">
                {scheduleTabs.map((tab) => (
                  <button
                    key={tab.key}
                    className={`tab ${form.scheduleType === tab.key ? "active" : ""}`}
                    onClick={() => setForm((f) => ({ ...f, scheduleType: tab.key }))}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="auto-schedule-panel">
                {form.scheduleType === "daily" && (
                  <div className="auto-row">
                    <span>{t("automations.dailyAt")}</span>
                    <input
                      type="time"
                      value={form.time}
                      onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}
                    />
                  </div>
                )}

                {form.scheduleType === "weekly" && (
                  <>
                    <div className="auto-weekdays">
                      {WEEK_DAYS.map((d) => (
                        <button
                          key={d.key}
                          className={`auto-weekday ${form.days.includes(d.key) ? "active" : ""}`}
                          onClick={() => toggleDay(d.key)}
                          title={t("automations.weekDay", { n: d.key })}
                        >
                          {d.label}
                        </button>
                      ))}
                    </div>
                    <div className="auto-row">
                      <span>{t("automations.weeklyAt")}</span>
                      <input
                        type="time"
                        value={form.time}
                        onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}
                      />
                    </div>
                  </>
                )}

                {form.scheduleType === "cron" && (
                  <>
                    <input
                      type="text"
                      value={form.cron}
                      onChange={(e) => setForm((f) => ({ ...f, cron: e.target.value }))}
                      placeholder={t("automations.cronPlaceholder")}
                    />
                    <div className="presets">
                      {PRESET_CRONS.map((p) => (
                        <button
                          key={p.cron}
                          className="btn small"
                          onClick={() =>
                            setForm((f) => ({ ...f, scheduleType: "cron", cron: p.cron }))
                          }
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {form.scheduleType === "once" && (
                  <div className="auto-row">
                    <input
                      type="date"
                      value={form.onceDate}
                      min={formatDate()}
                      onChange={(e) => setForm((f) => ({ ...f, onceDate: e.target.value }))}
                    />
                    <input
                      type="time"
                      value={form.onceTime}
                      onChange={(e) => setForm((f) => ({ ...f, onceTime: e.target.value }))}
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="auto-field">
              <label>{t("automations.validityLabel")}</label>
              <div className="auto-row">
                <input
                  type="date"
                  value={form.validFrom}
                  onChange={(e) => setForm((f) => ({ ...f, validFrom: e.target.value }))}
                  placeholder={t("automations.validFrom")}
                />
                <span>→</span>
                <input
                  type="date"
                  value={form.validUntil}
                  min={form.validFrom || undefined}
                  onChange={(e) => setForm((f) => ({ ...f, validUntil: e.target.value }))}
                  placeholder={t("automations.validUntil")}
                />
              </div>
              <p className="auto-field-hint">{t("automations.validityHint")}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
