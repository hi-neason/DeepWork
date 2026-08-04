import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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

const TABS: Array<{ id: SettingsTab; labelKey: string; icon: string }> = [
  { id: "general", labelKey: "settings.tabs.general", icon: "⚙" },
  { id: "models", labelKey: "settings.tabs.models", icon: "◇" },
  { id: "memory", labelKey: "settings.tabs.memory", icon: "🧠" },
  { id: "shortcuts", labelKey: "settings.tabs.shortcuts", icon: "?" },
];

export function Settings({
  onClose,
  initialTab = "general",
  updateStatus,
}: Props): React.ReactElement {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      setSettings(await window.deepwork.settings.get());
    })();
  }, []);

  if (!settings) return <div className="settings-shell">{t("common.loading")}</div>;

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
        <div className="settings-title">{t("settings.title")}</div>
        {TABS.map((tdef) => (
          <button
            key={tdef.id}
            className={`settings-nav-item ${tab === tdef.id ? "active" : ""}`}
            onClick={() => setTab(tdef.id)}
          >
            <span className="nav-icon">{tdef.icon}</span>
            {t(tdef.labelKey)}
          </button>
        ))}
        <button className="settings-nav-item close" onClick={onClose}>
          ✕ {t("settings.close")}
        </button>
      </aside>

      <div className="settings-content">
        <div className="settings-save-bar">
          {saved && <span style={{ color: "var(--ok)" }}>{t("settings.saved")} ✓</span>}
          <button className="btn secondary" onClick={save}>
            {t("common.saveAndApply")}
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
