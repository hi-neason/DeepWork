import { useEffect, useRef, useState } from "react";
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
import { Connectors } from "./Connectors";
import { AutomationsView } from "./AutomationsView";
import { SkillsView } from "./SkillsView";
import { applyAppearance } from "../lib/theme";
import {
  BrainCircuit,
  CircleHelp,
  Clock3,
  Cpu,
  PlugZap,
  Settings2,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";

interface Props {
  onClose: () => void;
  initialTab?: SettingsTab;
  updateStatus?: UpdateStatus;
  onSaved?: () => void;
}

const TABS: Array<{ id: SettingsTab; labelKey: string; icon: LucideIcon; wip?: boolean }> = [
  { id: "general", labelKey: "settings.tabs.general", icon: Settings2 },
  { id: "models", labelKey: "settings.tabs.models", icon: Cpu },
  { id: "memory", labelKey: "settings.tabs.memory", icon: BrainCircuit },
  { id: "skills", labelKey: "settings.tabs.skills", icon: Sparkles },
  { id: "connectors", labelKey: "settings.tabs.connectors", icon: PlugZap },
  { id: "automations", labelKey: "settings.tabs.automations", icon: Clock3 },
  { id: "about", labelKey: "settings.tabs.about", icon: CircleHelp },
];

// Debounce window for auto-saving settings changes to disk.
const SAVE_DEBOUNCE_MS = 500;

export function Settings({
  onClose,
  initialTab = "general",
  updateStatus,
  onSaved,
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

  // Auto-save: whenever the settings object changes (driven by the tab forms),
  // debounce a persist + applySystem + rebuildAgent. There is no global save
  // button — every control saves itself.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstSkip = useRef(true);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  useEffect(() => {
    if (!settings) return;
    // Skip the initial load (we just read it, nothing to save).
    if (firstSkip.current) {
      firstSkip.current = false;
      return;
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void (async () => {
        try {
          await window.deepwork.settings.save(settings);
          await window.deepwork.settings.applySystem();
          await window.deepwork.settings.rebuildAgent();
          setSaved(true);
          setTimeout(() => setSaved(false), 1200);
          onSavedRef.current?.();
        } catch (err) {
          // Native MCP approval already explains a denial. Restore the
          // persisted settings so an unapproved configuration is not shown as active.
          console.error("settings save failed", err);
          setSettings(await window.deepwork.settings.get());
        }
      })();
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [settings]);

  // Apply theme/font-scale live as the user tweaks the controls (e.g. dragging
  // the font-size slider), rather than waiting for App to re-read settings.
  useEffect(() => {
    if (settings) applyAppearance(settings);
  }, [settings?.theme, settings?.fontScale, settings?.language]);

  if (!settings) return <div className="settings-shell">{t("common.loading")}</div>;

  const updateModel = (patch: Partial<SettingsType["model"]>): void => {
    setSettings({ ...settings, model: { ...settings.model, ...patch } });
  };

  const update = (patch: Partial<SettingsType>): void => {
    setSettings({ ...settings, ...patch });
  };
  const activeTab = TABS.find((entry) => entry.id === tab) ?? TABS[0];

  return (
    <div className="settings-shell">
      <aside className="settings-nav" aria-label={t("settings.navigation")}>
        <div className="settings-title-row">
          <span className="settings-title">{t("settings.title")}</span>
          <button
            className="settings-close"
            onClick={onClose}
            title={t("settings.close")}
            aria-label={t("settings.close")}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="settings-nav-list" role="tablist" aria-orientation="vertical">
          {TABS.map((tdef) => {
            const TabIcon = tdef.icon;
            return (
              <button
                key={tdef.id}
                id={`settings-tab-${tdef.id}`}
                className={`settings-nav-item ${tab === tdef.id ? "active" : ""}`}
                onClick={() => setTab(tdef.id)}
                role="tab"
                aria-selected={tab === tdef.id}
                aria-controls={`settings-panel-${tdef.id}`}
              >
                <TabIcon className="nav-icon" aria-hidden="true" />
                <span className="settings-nav-label">{t(tdef.labelKey)}</span>
                {tdef.wip && <span className="wip-badge">{t("settings.wip")}</span>}
              </button>
            );
          })}
        </div>
      </aside>

      <div className="settings-content">
        <div className="settings-save-bar">
          <span className="settings-current-section">{t(activeTab.labelKey)}</span>
          <span className={`settings-save-state ${saved ? "saved" : ""}`} aria-live="polite">
            <span className="settings-save-dot" aria-hidden="true" />
            {saved ? t("settings.saved") : t("settings.autoSave")}
          </span>
        </div>

        <div className="settings-scroll">
          <div
            key={tab}
            id={`settings-panel-${tab}`}
            className="settings-panel"
            role="tabpanel"
            aria-labelledby={`settings-tab-${tab}`}
          >
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
            {tab === "skills" && <SkillsView settings={settings} />}
            {tab === "connectors" && (
              <Connectors settings={settings} onChange={update} />
            )}
            {tab === "automations" && <AutomationsView />}
            {tab === "about" && <AboutTab updateStatus={updateStatus ?? { state: "idle" }} />}
          </div>
        </div>
      </div>
    </div>
  );
}
