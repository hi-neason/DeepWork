import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";

const SECTION_IDS = ["personal", "workstyle", "focus", "recent"] as const;
type SectionId = (typeof SECTION_IDS)[number];

interface SectionState {
  [key: string]: string;
}

export function MemoryTab(): React.ReactElement {
  const { t } = useTranslation();
  const [sections, setSections] = useState<SectionState>({});
  const [editing, setEditing] = useState<SectionId | null>(null);
  const [draft, setDraft] = useState<SectionState>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [memoryPath, setMemoryPath] = useState("");

  const load = useCallback(async () => {
    const data = await window.deepwork.userMemory.read();
    setSections(data);
    setDraft({ ...data });
    setMemoryPath(await window.deepwork.userMemory.path());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startEdit = (id: SectionId) => {
    setEditing(id);
    setDraft((prev) => ({ ...prev, [id]: sections[id] ?? "" }));
  };

  const cancelEdit = () => {
    setEditing(null);
    setDraft((prev) => {
      const next = { ...prev };
      for (const id of SECTION_IDS) next[id] = sections[id] ?? "";
      return next;
    });
  };

  const saveSection = async (id: SectionId) => {
    setSaving(true);
    try {
      const updated = { ...sections, [id]: draft[id] ?? "" };
      await window.deepwork.userMemory.save(updated);
      setSections(updated);
      setEditing(null);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  const updateDraft = (id: SectionId, value: string) => {
    setDraft((prev) => ({ ...prev, [id]: value }));
  };

  return (
    <div className="settings-section">
      <h2>{t("settings.memory.title")}</h2>
      <p className="section-desc">{t("settings.memory.desc")}</p>

      <div className="setting-card">
        {/* File path hint */}
        <div className="um-path-hint">
          <span className="um-path-label">{t("settings.memory.fileLabel")}</span>
          <code className="um-path-value">{memoryPath}</code>
        </div>

        {/* Sections */}
        <div className="um-sections">
          {SECTION_IDS.map((id) => (
            <div key={id} className="um-section">
              <div className="um-section-header">
                <span className="um-section-title">
                  {t(`settings.memory.sections.${id}`)}
                </span>
                {editing === id ? (
                  <div className="um-section-actions">
                    <button
                      className={`btn small ${saving ? "disabled" : "primary"}`}
                      onClick={() => void saveSection(id)}
                      disabled={saving}
                    >
                      {t("common.save")}
                    </button>
                    <button
                      className="btn small"
                      onClick={cancelEdit}
                      disabled={saving}
                    >
                      {t("rightPanel.cancel")}
                    </button>
                  </div>
                ) : (
                  <button
                    className="icon-btn um-edit-btn"
                    onClick={() => startEdit(id)}
                    title={t("settings.memory.editSection")}
                  >
                    ✎
                  </button>
                )}
              </div>

              {editing === id ? (
                <textarea
                  className="um-textarea"
                  value={draft[id] ?? ""}
                  onChange={(e) => updateDraft(id, e.target.value)}
                  placeholder={t(`settings.memory.placeholders.${id}`)}
                  rows={id === "recent" ? 8 : 6}
                  autoFocus
                />
              ) : (
                <div className="um-content">
                  {(sections[id] && sections[id].trim()) ? (
                    <pre className="um-pre">{sections[id]}</pre>
                  ) : (
                    <p className="setting-hint um-empty">
                      {t(`settings.memory.placeholders.${id}`)}
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Saved indicator */}
        {savedAt && (
          <p className="um-saved">
            {t("settings.memory.saved")}{" "}
            {new Date(savedAt).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        )}
      </div>
    </div>
  );
}
