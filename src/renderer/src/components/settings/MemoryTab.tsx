import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MemoryItem } from "../../../../shared/types";

export function MemoryTab(): React.ReactElement {
  const { t } = useTranslation();
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [text, setText] = useState("");

  const refresh = async (): Promise<void> => {
    setMemories(await window.deepwork.memories.list());
  };
  useEffect(() => {
    void refresh();
  }, []);

  const add = async (): Promise<void> => {
    const content = text.trim();
    if (!content) return;
    await window.deepwork.memories.add(content);
    setText("");
    await refresh();
  };

  const remove = async (id: string): Promise<void> => {
    await window.deepwork.memories.remove(id);
    await refresh();
  };

  return (
    <div className="settings-section">
      <h2>{t("settings.memory.title")}</h2>
      <p className="section-desc">{t("settings.memory.desc")}</p>

      <div className="setting-card">
        <div className="field">
          <label>{t("settings.memory.addLabel")}</label>
          <div className="row">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void add()}
              placeholder={t("settings.memory.placeholder")}
            />
            <button className="btn primary" onClick={add}>
              {t("common.add")}
            </button>
          </div>
        </div>

        <div className="memory-list">
          {memories.length === 0 && (
            <p className="setting-hint">{t("settings.memory.empty")}</p>
          )}
          {memories.map((m) => (
            <div key={m.id} className="memory-item">
              <span>{m.content}</span>
              <button className="icon-btn" onClick={() => remove(m.id)} title={t("settings.memory.forget")}>
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
