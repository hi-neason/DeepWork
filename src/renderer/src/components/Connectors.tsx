import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { McpServerConfig, Settings as SettingsType, Skill } from "../../../shared/types";

interface Props {
  onClose: () => void;
}

type Tab = "mcp" | "skills";

// `label` is the cosmetic display label; `labelKey` is its i18n key. The
// `description`/`body` are written into the created skill verbatim and are NOT
// translated (they are prompt content authored by the user/templates).
const SKILL_TEMPLATES: {
  label: string;
  labelKey: string;
  name: string;
  description: string;
  body: string;
}[] = [
  {
    label: "Blank skill",
    labelKey: "connectors.tplBlank",
    name: "my-skill",
    description: "Describe when this skill should be used.",
    body: "# Instructions\n\nWhat the agent should do when this skill is loaded.\n",
  },
  {
    label: "Code reviewer",
    labelKey: "connectors.tplReviewer",
    name: "code-review",
    description: "Review code changes for bugs, style and security before committing.",
    body:
      "# Code review\n\n" +
      "When asked to review code:\n" +
      "1. Read the diff or changed files.\n" +
      "2. Flag correctness bugs first, then security, then style.\n" +
      "3. Give concrete suggestions with file:line references.\n" +
      "4. Summarize risk level (low/medium/high).\n",
  },
  {
    label: "Commit message writer",
    labelKey: "connectors.tplCommit",
    name: "commit-writer",
    description: "Write concise Conventional Commits messages from staged changes.",
    body:
      "# Commit writer\n\n" +
      "Run `git diff --staged`, summarize the change in one line, then write a\n" +
      "Conventional Commits message (type(scope): subject). Keep subject ≤ 72 chars.\n",
  },
];

export function Connectors({ onClose }: Props): React.ReactElement {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("mcp");
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [saved, setSaved] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);

  const refreshSkills = async (): Promise<void> => {
    setSkills(await window.deepwork.skills.list());
  };

  useEffect(() => {
    void window.deepwork.settings.get().then(setSettings);
    void refreshSkills();
  }, []);

  if (!settings) return <div className="settings">{t("common.loading")}</div>;

  const updateMcp = (id: string, patch: Partial<McpServerConfig>): void => {
    setSettings({
      ...settings,
      mcpServers: settings.mcpServers.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    });
  };
  const addMcp = (): void => {
    const srv: McpServerConfig = {
      id: `mcp-${Date.now()}`,
      label: "New MCP server",
      transport: "stdio",
      command: "",
      args: [],
      enabled: true,
    };
    setSettings({ ...settings, mcpServers: [...settings.mcpServers, srv] });
  };
  const removeMcp = (id: string): void => {
    setSettings({ ...settings, mcpServers: settings.mcpServers.filter((m) => m.id !== id) });
  };

  const saveMcp = async (): Promise<void> => {
    await window.deepwork.settings.save(settings);
    await window.deepwork.settings.rebuildAgent();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const createFromTemplate = async (tpl: (typeof SKILL_TEMPLATES)[number]): Promise<void> => {
    const s = await window.deepwork.skills.create({
      name: tpl.name,
      description: tpl.description,
      body: tpl.body,
    });
    await refreshSkills();
    setEditingSkill(s);
  };

  const saveSkill = async (patch: Partial<Skill>): Promise<void> => {
    if (!editingSkill) return;
    const s = await window.deepwork.skills.update(editingSkill.name, patch);
    if (s) setEditingSkill(s);
    await refreshSkills();
    await window.deepwork.skills.rebuild();
  };

  const deleteSkill = async (name: string): Promise<void> => {
    await window.deepwork.skills.delete(name);
    await refreshSkills();
    await window.deepwork.skills.rebuild();
    if (editingSkill?.name === name) setEditingSkill(null);
  };

  const toggleSkill = async (name: string, enabled: boolean): Promise<void> => {
    await window.deepwork.skills.update(name, { enabled });
    await refreshSkills();
    await window.deepwork.skills.rebuild();
    if (editingSkill?.name === name) setEditingSkill((s) => (s ? { ...s, enabled } : s));
  };

  return (
    <div className="settings">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>{t("connectors.title")}</h2>
        <button className="btn" onClick={onClose}>
          {t("common.close")}
        </button>
      </div>

      <div className="tabs">
        <button
          className={`tab ${tab === "mcp" ? "active" : ""}`}
          onClick={() => setTab("mcp")}
        >
          🧩 {t("connectors.tabMcp", { count: settings.mcpServers.length })}
        </button>
        <button
          className={`tab ${tab === "skills" ? "active" : ""}`}
          onClick={() => setTab("skills")}
        >
          ✨ {t("connectors.tabSkills", { count: skills.length })}
        </button>
      </div>

      {tab === "mcp" && (
        <>
          <p className="tab-hint">{t("connectors.mcpHint")}</p>
          {settings.mcpServers.map((m) => (
            <div key={m.id} className="mcp-card">
              <div className="field">
                <label>{t("connectors.label")}</label>
                <input value={m.label} onChange={(e) => updateMcp(m.id, { label: e.target.value })} />
              </div>
              <div className="field">
                <label>Transport</label>
                <select
                  value={m.transport}
                  onChange={(e) =>
                    updateMcp(m.id, { transport: e.target.value as McpServerConfig["transport"] })
                  }
                >
                  <option value="stdio">stdio</option>
                  <option value="sse">SSE / HTTP</option>
                </select>
              </div>
              {m.transport === "stdio" ? (
                <>
                  <div className="field">
                    <label>{t("connectors.command")}</label>
                    <input
                      value={m.command ?? ""}
                      onChange={(e) => updateMcp(m.id, { command: e.target.value })}
                      placeholder="npx"
                    />
                  </div>
                  <div className="field">
                    <label>{t("connectors.args")}</label>
                    <input
                      value={(m.args ?? []).join(" ")}
                      onChange={(e) =>
                        updateMcp(m.id, { args: e.target.value.split(" ").filter(Boolean) })
                      }
                      placeholder="-y @modelcontextprotocol/server-filesystem /"
                    />
                  </div>
                </>
              ) : (
                <div className="field">
                  <label>{t("connectors.url")}</label>
                  <input
                    value={m.url ?? ""}
                    onChange={(e) => updateMcp(m.id, { url: e.target.value })}
                    placeholder="http://localhost:3000/sse"
                  />
                </div>
              )}
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <label>
                  <input
                    type="checkbox"
                    checked={m.enabled}
                    onChange={(e) => updateMcp(m.id, { enabled: e.target.checked })}
                  />{" "}
                  {t("connectors.enabled")}
                </label>
                <button className="btn danger" onClick={() => removeMcp(m.id)}>
                  {t("connectors.remove")}
                </button>
              </div>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={addMcp}>
              {t("connectors.addMcp")}
            </button>
            <button className="btn primary" onClick={saveMcp}>
              {t("common.saveAndApply")}
            </button>
            {saved && <span style={{ color: "var(--ok)", alignSelf: "center" }}>{t("settings.saved")} ✓</span>}
          </div>
        </>
      )}

      {tab === "skills" && (
        <>
          <p className="tab-hint">{t("connectors.skillsHint")}</p>

          {editingSkill ? (
            <SkillEditor
              skill={editingSkill}
              onChange={setEditingSkill}
              onSave={() =>
                saveSkill({
                  description: editingSkill.description,
                  body: editingSkill.body,
                  enabled: editingSkill.enabled,
                })
              }
              onDelete={() => deleteSkill(editingSkill.name)}
              onClose={() => setEditingSkill(null)}
            />
          ) : (
            <>
              <div className="skill-templates">
                {SKILL_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.label}
                    className="skill-template"
                    onClick={() => createFromTemplate(tpl)}
                  >
                    + {t(tpl.labelKey)}
                  </button>
                ))}
              </div>
              <div className="skill-list">
                {skills.length === 0 && (
                  <p className="artifacts-empty">{t("connectors.noSkills")}</p>
                )}
                {skills.map((s) => (
                  <div key={s.name} className="skill-item">
                    <div className="skill-main" onClick={() => setEditingSkill(s)}>
                      <div className="skill-name">{s.name}</div>
                      <div className="skill-desc">{s.description || "—"}</div>
                    </div>
                    <label className="skill-toggle">
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        onChange={(e) => void toggleSkill(s.name, e.target.checked)}
                      />
                    </label>
                    <button className="icon-btn" title={t("common.delete")} onClick={() => deleteSkill(s.name)}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function SkillEditor({
  skill,
  onChange,
  onSave,
  onDelete,
  onClose,
}: {
  skill: Skill;
  onChange: (s: Skill) => void;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="skill-editor">
      <div className="skill-editor-head">
        <code>{skill.name}/SKILL.md</code>
        <button className="btn" onClick={onClose}>
          {t("connectors.back")}
        </button>
      </div>
      <div className="field">
        <label>{t("connectors.descLabel")}</label>
        <input
          value={skill.description}
          onChange={(e) => onChange({ ...skill, description: e.target.value })}
        />
      </div>
      <div className="field">
        <label>{t("connectors.instructionsLabel")}</label>
        <textarea
          rows={16}
          value={skill.body}
          onChange={(e) => onChange({ ...skill, body: e.target.value })}
        />
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label>
          <input
            type="checkbox"
            checked={skill.enabled}
            onChange={(e) => onChange({ ...skill, enabled: e.target.checked })}
          />{" "}
          {t("connectors.enabled")}
        </label>
        <button className="btn primary" onClick={onSave}>
          {t("connectors.saveSkill")}
        </button>
        <button className="btn danger" onClick={onDelete}>
          {t("common.delete")}
        </button>
      </div>
    </div>
  );
}
