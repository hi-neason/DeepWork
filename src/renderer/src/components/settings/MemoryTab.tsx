import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";

export function MemoryTab(): React.ReactElement {
  const { t } = useTranslation();
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [memoryPath, setMemoryPath] = useState("");

  const load = useCallback(async () => {
    const raw = await window.deepwork.userMemory.raw();
    setContent(raw);
    setOriginal(raw);
    setMemoryPath(await window.deepwork.userMemory.path());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = content !== original;

  const save = async () => {
    setSaving(true);
    try {
      await window.deepwork.userMemory.saveRaw(content);
      setOriginal(content);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  const reset = () => setContent(original);

  return (
    <div className="settings-section">
      <h2>{t("settings.memory.title")}</h2>
      <p className="section-desc">{t("settings.memory.desc")}</p>

      <div className="setting-card">
        <div className="um-path-hint">
          <span className="um-path-label">{t("settings.memory.fileLabel")}</span>
          <code className="um-path-value">{memoryPath}</code>
        </div>

        <h3 className="um-heading">{t("settings.memory.heading")}</h3>

        <p className="setting-hint um-edit-hint">{t("settings.memory.editHint")}</p>

        <textarea
          className="um-editor"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
        />

        <div className="um-actions">
          <button
            className={`btn primary ${saving ? "disabled" : ""}`}
            onClick={() => void save()}
            disabled={saving || !dirty}
          >
            {t("common.save")}
          </button>
          <button className="btn" onClick={reset} disabled={saving || !dirty}>
            {t("rightPanel.cancel")}
          </button>
          {savedAt && !dirty && (
            <span className="um-saved">
              {t("settings.memory.saved")}{" "}
              {new Date(savedAt).toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
