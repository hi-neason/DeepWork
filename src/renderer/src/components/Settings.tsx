import { useEffect, useState } from "react";
import type {
  Settings as SettingsType,
  SettingsTab,
  UpdateStatus,
} from "../../../shared/types";
import { GeneralTab } from "./settings/GeneralTab";
import { ModelsTab } from "./settings/ModelsTab";
import { MemoryTab } from "./settings/MemoryTab";
import { AboutTab } from "./settings/AboutTab";

interface Props {
  onClose: () => void;
  initialTab?: SettingsTab;
  updateStatus?: UpdateStatus;
}

const TABS: Array<{ id: SettingsTab; label: string; icon: string }> = [
  { id: "general", label: "通用", icon: "⚙" },
  { id: "models", label: "模型", icon: "◇" },
  { id: "memory", label: "记忆", icon: "🧠" },
  { id: "shortcuts", label: "快捷键 / 关于", icon: "?" },
];

export function Settings({
  onClose,
  initialTab = "general",
  updateStatus,
}: Props): React.ReactElement {
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      setSettings(await window.deepwork.settings.get());
    })();
  }, []);

  if (!settings) return <div className="settings-shell">Loading…</div>;

  const updateModel = (patch: Partial<SettingsType["model"]>): void => {
    setSettings({ ...settings, model: { ...settings.model, ...patch } });
  };

  const update = (patch: Partial<SettingsType>): void => {
    setSettings({ ...settings, ...patch });
  };

  const save = async (): Promise<void> => {
    await window.deepwork.settings.save(settings);
    await window.deepwork.settings.applySystem();
    await window.deepwork.settings.rebuildAgent();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="settings-shell">
      <aside className="settings-nav">
        <div className="settings-title">设置</div>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`settings-nav-item ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            <span className="nav-icon">{t.icon}</span>
            {t.label}
          </button>
        ))}
        <button className="settings-nav-item close" onClick={onClose}>
          ✕ 关闭
        </button>
      </aside>

      <div className="settings-content">
        <div className="settings-save-bar">
          {saved && <span style={{ color: "var(--ok)" }}>已保存 ✓</span>}
          <button className="btn secondary" onClick={save}>
            保存并应用
          </button>
        </div>

        <div className="settings-scroll">
          {tab === "general" && (
            <GeneralTab
              settings={settings}
              onChange={update}
              onModelChange={updateModel}
            />
          )}
          {tab === "models" && (
            <ModelsTab
              settings={settings}
              onChange={updateModel}
              onSettingsChange={(patch) => setSettings({ ...settings, ...patch })}
            />
          )}
          {tab === "memory" && <MemoryTab />}
          {tab === "shortcuts" && <AboutTab updateStatus={updateStatus ?? { state: "idle" }} />}
        </div>
      </div>
    </div>
  );
}
