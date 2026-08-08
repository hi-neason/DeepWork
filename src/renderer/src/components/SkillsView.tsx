import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Skill, Settings as SettingsType } from "../../../shared/types";
import { formatBytes } from "../lib/format";

interface Props {
  settings: SettingsType;
}

const SAVE_DEBOUNCE_MS = 600;

export function SkillsView({ settings: _settings }: Props): React.ReactElement {
  const { t } = useTranslation();

  const [skills, setSkills] = useState<Skill[]>([]);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    const list = await window.deepwork.skills.list();
    setSkills(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const applyRebuild = useCallback(async (): Promise<void> => {
    await window.deepwork.skills.rebuild();
  }, []);

  // ---------- create ----------
  const startCreate = (): void => {
    // Leaving the editor for the create panel: persist pending edits first.
    if (dirtyRef.current) void flushSave();
    setCreating(true);
    setEditing(null);
  };

  // ---------- update (auto-save) ----------
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);
  // Always holds the latest editing state so the debounced timer reads the
  // current value rather than the stale closure from the render that scheduled
  // it (which otherwise drops the last keystroke).
  const editingRef = useRef<Skill | null>(null);
  editingRef.current = editing;

  const flushSave = useCallback(async (): Promise<void> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const current = editingRef.current;
    if (!current || !dirtyRef.current) return;
    // Snapshot the skill name; if the editor closes mid-flight, editingRef
    // becomes null and we must NOT call setEditing afterward (which would
    // re-open the panel on the now-unmounted context).
    try {
      const s = await window.deepwork.skills.update(current.name, {
        description: current.description,
        body: current.body,
        enabled: current.enabled,
      });
      dirtyRef.current = false;
      if (editingRef.current && s) setEditing(s);
      await refresh();
      await applyRebuild();
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    } catch (err) {
      console.error("Skill auto-save failed:", err);
    }
  }, [refresh, applyRebuild]);

  const patchEditing = (patch: Partial<Skill>): void => {
    if (!editing) return;
    const next = { ...editing, ...patch };
    setEditing(next);
    editingRef.current = next;
    dirtyRef.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void flushSave();
    }, SAVE_DEBOUNCE_MS);
  };

  // Flush any pending debounced save on unmount so edits are not lost when the
  // settings view is closed while a save timer is still pending.
  useEffect(() => {
    return () => {
      if (dirtyRef.current) void flushSave();
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [flushSave]);

  // ---------- toggle ----------
  const toggle = async (name: string, enabled: boolean): Promise<void> => {
    await window.deepwork.skills.update(name, { enabled });
    await refresh();
    await applyRebuild();
    if (editing?.name === name) setEditing((s) => (s ? { ...s, enabled } : s));
  };

  // ---------- delete ----------
  const remove = async (name: string): Promise<void> => {
    if (!confirm(t("skills.confirmDelete", { name }))) return;
    await window.deepwork.skills.delete(name);
    await refresh();
    await applyRebuild();
    if (editing?.name === name) setEditing(null);
  };

  // ---------- rename ----------
  const rename = async (newName: string): Promise<void> => {
    if (!editing) return;
    try {
      const s = await window.deepwork.skills.rename(editing.name, newName);
      if (s) setEditing(s);
      await refresh();
      await applyRebuild();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  // ---------- import / export ----------
  const importFromFolder = async (): Promise<void> => {
    const dir = await window.deepwork.settings.pickDirectory();
    if (!dir) return;
    try {
      const s = await window.deepwork.skills.import(dir);
      await refresh();
      await applyRebuild();
      setEditing(s);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const exportToFolder = async (name: string): Promise<void> => {
    const dir = await window.deepwork.settings.pickDirectory();
    if (!dir) return;
    try {
      const dest = await window.deepwork.skills.export(name, dir);
      alert(t("skills.exportedTo", { path: dest }));
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  // ---------- render ----------
  if (loading) return <div className="settings-section">{t("common.loading")}</div>;

  return (
    <div className="settings-section skills-section">
      <h2>{t("skills.title")}</h2>
      <p className="section-desc">{t("skills.hint")}</p>

      {editing ? (
        <SkillEditor
          skill={editing}
          saved={saved}
          onChange={patchEditing}
          onRename={rename}
          onDelete={() => remove(editing.name)}
          onExport={() => exportToFolder(editing.name)}
          onClose={() => {
            // Flush pending edits before leaving the editor so the last
            // keystroke (within the debounce window) is persisted.
            if (dirtyRef.current) void flushSave();
            if (saveTimer.current) {
              clearTimeout(saveTimer.current);
              saveTimer.current = null;
            }
            editingRef.current = null;
            setEditing(null);
            dirtyRef.current = false;
          }}
        />
      ) : creating ? (
        <CreateSkillPanel
          onCancel={() => setCreating(false)}
          onCreated={(s) => {
            setCreating(false);
            setEditing(s);
            void refresh();
            void applyRebuild();
          }}
        />
      ) : (
        <>
          <div className="skill-toolbar">
            <button className="btn primary" onClick={startCreate}>
              + {t("skills.new")}
            </button>
            <button className="btn" onClick={importFromFolder}>
              {t("skills.import")}
            </button>
            {saved && (
              <span className="auto-save-hint" style={{ color: "var(--ok)" }}>
                {t("settings.saved")} ✓
              </span>
            )}
          </div>

          <div className="skill-list">
            {skills.length === 0 && (
              <p className="artifacts-empty">{t("skills.empty")}</p>
            )}
            {skills.map((s) => (
              <div key={s.name} className="skill-item">
                <div className="skill-main" onClick={() => setEditing(s)}>
                  <div className="skill-name-row">
                    <span className="skill-name">{s.name}</span>
                  </div>
                  <div className="skill-desc">{s.description || "—"}</div>
                  {s.files.length > 0 && (
                    <div className="skill-files">
                      {countByKind(s.files, "script") > 0 && (
                        <span className="skill-file-tag">
                          {countByKind(s.files, "script")} {t("skills.filesScripts")}
                        </span>
                      )}
                      {countByKind(s.files, "reference") > 0 && (
                        <span className="skill-file-tag">
                          {countByKind(s.files, "reference")} {t("skills.filesRefs")}
                        </span>
                      )}
                      {countByKind(s.files, "asset") > 0 && (
                        <span className="skill-file-tag">
                          {countByKind(s.files, "asset")} {t("skills.filesAssets")}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <label className="skill-toggle">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={(e) => void toggle(s.name, e.target.checked)}
                  />
                </label>
                <button
                  className="icon-btn"
                  title={t("skills.export")}
                  onClick={() => void exportToFolder(s.name)}
                >
                  ↗
                </button>
                <button
                  className="icon-btn"
                  title={t("common.delete")}
                  onClick={() => void remove(s.name)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create panel
// ---------------------------------------------------------------------------

function CreateSkillPanel({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (s: Skill) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");

  const submit = async (): Promise<void> => {
    setError("");
    try {
      const s = await window.deepwork.skills.create({ name, description, body: "" });
      onCreated(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="skill-create">
      <div className="field">
        <label>{t("skills.nameLabel")}</label>
        <input
          autoFocus
          value={name}
          placeholder="my-awesome-skill"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
        />
      </div>
      <div className="field">
        <label>{t("skills.descLabel")}</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
        />
      </div>
      {error && <div className="field-error">{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary" onClick={() => void submit()}>
          {t("skills.create")}
        </button>
        <button className="btn" onClick={onCancel}>{t("common.cancel")}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function SkillEditor({
  skill,
  saved,
  onChange,
  onRename,
  onDelete,
  onExport,
  onClose,
}: {
  skill: Skill;
  saved: boolean;
  onChange: (patch: Partial<Skill>) => void;
  onRename: (newName: string) => void;
  onDelete: () => void;
  onExport: () => void;
  onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(skill.name);

  return (
    <div className="skill-editor">
      <div className="skill-editor-head">
        <div className="skill-editor-title">
          {renaming ? (
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={() => { if (newName !== skill.name) onRename(newName); setRenaming(false); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); }
                if (e.key === "Escape") { setNewName(skill.name); setRenaming(false); }
              }}
              className="skill-name-input"
            />
          ) : (
            <code
              className="skill-name-code"
              title={t("skills.renameHint")}
              onClick={() => { setNewName(skill.name); setRenaming(true); }}
            >
              {skill.name}/SKILL.md
            </code>
          )}
        </div>
        <div className="skill-editor-actions">
          <button className="btn" onClick={onClose}>{t("skills.back")}</button>
        </div>
      </div>

      {saved && (
        <div className="save-indicator" style={{ color: "var(--ok)", marginBottom: 8 }}>
          {t("settings.saved")} ✓
        </div>
      )}

      <div className="field">
        <label>{t("skills.descLabel")}</label>
        <input
          value={skill.description}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </div>
      <div className="field">
        <label>{t("skills.bodyLabel")}</label>
        <textarea
          rows={18}
          value={skill.body}
          onChange={(e) => onChange({ body: e.target.value })}
        />
      </div>

      {skill.files.length > 0 && (
        <div className="field">
          <label>{t("skills.filesLabel")}</label>
          <ul className="skill-file-list">
            {skill.files.map((f) => (
              <li key={f.path} className={`skill-file kind-${f.kind}`}>
                <span className="skill-file-path">{f.path}</span>
                <span className="skill-file-size">{formatBytes(f.size)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="skill-editor-footer">
        <label>
          <input
            type="checkbox"
            checked={skill.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />{" "}
          {t("skills.enabled")}
        </label>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={onExport}>{t("skills.export")}</button>
        <button className="btn danger" onClick={onDelete}>{t("common.delete")}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countByKind(files: Skill["files"], kind: Skill["files"][number]["kind"]): number {
  return files.filter((f) => f.kind === kind).length;
}