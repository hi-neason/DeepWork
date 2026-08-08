import { useEffect, useState } from "react";
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

/** Strip the "provider:" prefix from a model id for compact display. */
function shortModelLabel(id: string): string {
  return id.includes(":") ? id.split(":").slice(1).join(":") : id;
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
  /** Model id chosen for this automation; "" means use the global default. */
  model: string;
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
    model: "",
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
    model: a.model || "",
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
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [showWsMenu, setShowWsMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const [showMcpPicker, setShowMcpPicker] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [mcpQuery, setMcpQuery] = useState("");

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
    try {
      const cfgModels = (await window.deepwork.settings.get()).configuredModels ?? [];
      setModels(
        cfgModels
          .filter((m) => m.enabled)
          .map((m) => ({ id: m.id, label: shortModelLabel(m.id) })),
      );
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
    if (!title || !instructions) {
      window.alert(t("automations.formIncomplete"));
      return;
    }
    if (form.scheduleType === "cron" && !form.cron.trim()) {
      window.alert(t("automations.cronRequired"));
      return;
    }
    if (form.scheduleType === "weekly" && form.days.length === 0) {
      window.alert(t("automations.weekdaysRequired"));
      return;
    }
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
      model: form.model || undefined,
    };
    try {
      if (editingId) {
        await window.deepwork.automations.update(editingId, payload);
      } else {
        await window.deepwork.automations.create(payload);
      }
      closeForm();
      await refresh();
    } catch (err) {
      console.error("automation save failed", err);
      window.alert(
        `${t("automations.saveError")}\n${err instanceof Error ? err.message : String(err)}`,
      );
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

  const filteredSkills = skills.filter((s) =>
    s.name.toLowerCase().includes(skillQuery.trim().toLowerCase()),
  );
  const filteredMcps = mcpServers.filter((s) =>
    (s.label || s.id).toLowerCase().includes(mcpQuery.trim().toLowerCase()),
  );

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
              {a.model && (
                <span className="auto-model" title={a.model}>
                  {shortModelLabel(a.model)}
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
              <button type="button" className="btn" onClick={closeForm} disabled={busy}>
                {t("common.cancel")}
              </button>
            </div>
          </div>

          <div className="auto-form-body">
            <div className="auto-banner">
              <span className="auto-banner-icon">ℹ</span>
              <span>{t("automations.banner")}</span>
            </div>

            <div className="auto-title-row">
              <input
                type="text"
                className="auto-title-input"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder={t("automations.namePlaceholder")}
              />
            </div>

            <div className="composer auto-composer">
              <div className="composer-box">
                {(form.skills.length > 0 || form.mcpServerIds.length > 0) && (
                  <div className="auto-composer-chips">
                    {form.skills.map((name) => (
                      <span key={name} className="auto-composer-chip">
                        <span className="auto-chip-kind">技能</span>
                        <span className="auto-chip-name">{name}</span>
                        <button
                          type="button"
                          className="auto-chip-x"
                          onClick={() => toggleSkill(name)}
                          title={t("common.remove")}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                    {form.mcpServerIds.map((id) => {
                      const s = mcpServers.find((x) => x.id === id);
                      return (
                        <span key={id} className="auto-composer-chip">
                          <span className="auto-chip-kind">MCP</span>
                          <span className="auto-chip-name">{s?.label || id}</span>
                          <button
                            type="button"
                            className="auto-chip-x"
                            onClick={() => toggleMcp(id)}
                            title={t("common.remove")}
                          >
                            ✕
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}

                <textarea
                  className="auto-instructions-input"
                  value={form.instructions}
                  onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
                  rows={4}
                  placeholder={t("automations.instructionsPlaceholder")}
                  autoFocus
                />

                <div className="composer-bar">
                  <div className="ws-picker-wrap">
                    <button
                      type="button"
                      className={`ws-picker ${form.workspaceDir ? "active" : ""}`}
                      onClick={() => setShowWsMenu((v) => !v)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
                      <span className="ws-picker-label">
                        {form.workspaceDir ? basename(form.workspaceDir) : t("automations.workspaceEmpty")}
                      </span>
                      {form.workspaceDir && (
                        <span
                          className="ws-clear"
                          onClick={(e) => {
                            e.stopPropagation();
                            setForm((f) => ({ ...f, workspaceDir: "" }));
                          }}
                        >
                          ✕
                        </span>
                      )}
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                    {showWsMenu && (
                      <div className="ws-menu" onMouseLeave={() => setShowWsMenu(false)}>
                        <div
                          className="ws-menu-item"
                          onClick={() => {
                            void pickWorkspace();
                            setShowWsMenu(false);
                          }}
                        >
                          {form.workspaceDir ? t("automations.changeWorkspace") : t("automations.pickWorkspace")}
                        </div>
                        {form.workspaceDir && (
                          <>
                            <div className="ws-menu-sep" />
                            <div
                              className="ws-menu-item danger"
                              onClick={() => {
                                setForm((f) => ({ ...f, workspaceDir: "" }));
                                setShowWsMenu(false);
                              }}
                            >
                              {t("chat.noFolder")}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="model-picker-wrap">
                    <button
                      type="button"
                      className="model-picker"
                      onClick={() => setShowModelMenu((v) => !v)}
                    >
                      <span className="model-dot" />
                      <span className="model-picker-label">
                        {form.model ? shortModelLabel(form.model) : t("automations.modelDefault")}
                      </span>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                    {showModelMenu && (
                      <div className="model-menu" onMouseLeave={() => setShowModelMenu(false)}>
                        <div
                          className={`model-menu-item ${!form.model ? "active" : ""}`}
                          onClick={() => {
                            setForm((f) => ({ ...f, model: "" }));
                            setShowModelMenu(false);
                          }}
                        >
                          <span>{t("automations.modelDefault")}</span>
                          {!form.model && <span className="check">✓</span>}
                        </div>
                        {models.map((m) => (
                          <div
                            key={m.id}
                            className={`model-menu-item ${form.model === m.id ? "active" : ""}`}
                            onClick={() => {
                              setForm((f) => ({ ...f, model: m.id }));
                              setShowModelMenu(false);
                            }}
                          >
                            <span>{m.label}</span>
                            {form.model === m.id && <span className="check">✓</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="auto-mode-seg">
                    {(["auto", "manual", "plan"] as PermissionMode[]).map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={`auto-mode-btn ${form.permissionMode === m ? "active" : ""}`}
                        onClick={() => setForm((f) => ({ ...f, permissionMode: m }))}
                      >
                        {t(`automations.mode.${m}`)}
                      </button>
                    ))}
                  </div>

                  <div className="auto-picker-wrap">
                    <button
                      type="button"
                      className={`auto-add-btn ${showSkillPicker ? "active" : ""}`}
                      onClick={() => {
                        setShowSkillPicker((v) => !v);
                        setShowMcpPicker(false);
                      }}
                    >
                      <span className="auto-add-plus">＋</span>
                      {t("automations.skillsLabel")}
                    </button>
                    {showSkillPicker && (
                      <div className="auto-picker-pop" onMouseLeave={() => setShowSkillPicker(false)}>
                        <input
                          className="auto-picker-search"
                          autoFocus
                          value={skillQuery}
                          onChange={(e) => setSkillQuery(e.target.value)}
                          placeholder={t("automations.searchPlaceholder")}
                        />
                        <div className="auto-picker-list">
                          {filteredSkills.length === 0 ? (
                            <div className="auto-picker-empty">{t("automations.noMatch")}</div>
                          ) : (
                            filteredSkills.map((s) => (
                              <div
                                key={s.name}
                                className={`auto-picker-item ${form.skills.includes(s.name) ? "checked" : ""}`}
                                onClick={() => toggleSkill(s.name)}
                              >
                                <div className="auto-picker-name">{s.name}</div>
                                {s.description && <div className="auto-picker-desc">{s.description}</div>}
                                {form.skills.includes(s.name) && <span className="auto-picker-check">✓</span>}
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="auto-picker-wrap">
                    <button
                      type="button"
                      className={`auto-add-btn ${showMcpPicker ? "active" : ""}`}
                      onClick={() => {
                        setShowMcpPicker((v) => !v);
                        setShowSkillPicker(false);
                      }}
                    >
                      <span className="auto-add-plus">＋</span>
                      {t("automations.mcpLabel")}
                    </button>
                    {showMcpPicker && (
                      <div className="auto-picker-pop" onMouseLeave={() => setShowMcpPicker(false)}>
                        <input
                          className="auto-picker-search"
                          autoFocus
                          value={mcpQuery}
                          onChange={(e) => setMcpQuery(e.target.value)}
                          placeholder={t("automations.searchPlaceholder")}
                        />
                        <div className="auto-picker-list">
                          {filteredMcps.length === 0 ? (
                            <div className="auto-picker-empty">{t("automations.noMatch")}</div>
                          ) : (
                            filteredMcps.map((s) => (
                              <div
                                key={s.id}
                                className={`auto-picker-item ${form.mcpServerIds.includes(s.id) ? "checked" : ""}`}
                                onClick={() => toggleMcp(s.id)}
                              >
                                <div className="auto-picker-name">{s.label || s.id}</div>
                                {form.mcpServerIds.includes(s.id) && <span className="auto-picker-check">✓</span>}
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="composer-right">
                    <button
                      type="button"
                      className="btn primary auto-send"
                      onClick={save}
                      disabled={busy}
                    >
                      {busy ? t("automations.saving") : t("common.save")}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="auto-schedule-section">
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
                            onClick={() => setForm((f) => ({ ...f, scheduleType: "cron", cron: p.cron }))}
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
        </div>
      )}
    </div>
  );
}
