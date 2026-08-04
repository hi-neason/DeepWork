import type { Settings } from "../../../../shared/types";
import { useTranslation } from "react-i18next";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onModelChange: (patch: Partial<Settings["model"]>) => void;
}

export function GeneralTab({ settings, onChange, onModelChange }: Props): React.ReactElement {
  const { t } = useTranslation();
  const pickWorkspace = async (): Promise<void> => {
    const dir = await window.deepwork.settings.pickDirectory();
    if (dir) onModelChange({ workspaceDir: dir });
  };
  return (
    <div className="settings-section">
      <h2>{t("settings.general.title")}</h2>
      <p className="section-desc">{t("settings.general.desc")}</p>

      <div className="setting-card">
        <div className="setting-head">{t("settings.general.theme")}</div>
        <div className="segmented">
          {(["light", "dark", "auto"] as const).map((tm) => (
            <button
              key={tm}
              className={settings.theme === tm ? "active" : ""}
              onClick={() => onChange({ theme: tm })}
            >
              {tm === "light"
                ? t("settings.general.themeLight")
                : tm === "dark"
                  ? t("settings.general.themeDark")
                  : t("settings.general.themeAuto")}
            </button>
          ))}
        </div>
        <p className="setting-hint">{t("settings.general.themeHint")}</p>
      </div>

      <div className="setting-card">
        <div className="setting-row">
          <div>
            <div className="setting-label">{t("settings.general.language")}</div>
            <div className="setting-hint">{t("settings.general.languageHint")}</div>
          </div>
          <select
            value={settings.language}
            onChange={(e) =>
              onChange({ language: e.target.value as Settings["language"] })
            }
          >
            <option value="zh-CN">中文（简体）</option>
            <option value="en-US">English</option>
          </select>
        </div>
      </div>

      <div className="setting-card">
        <div className="setting-row">
          <div>
            <div className="setting-label">{t("settings.general.fontSize")}</div>
          </div>
          <div className="slider-wrap">
            <span>{t("settings.general.fontSmall")}</span>
            <input
              type="range"
              min={0.9}
              max={1.3}
              step={0.05}
              value={settings.fontScale}
              onChange={(e) => onChange({ fontScale: Number(e.target.value) })}
            />
            <span>{t("settings.general.fontLarge")}</span>
          </div>
        </div>
      </div>

      <div className="setting-card">
        <div className="setting-label">{t("settings.general.workspace")}</div>
        <div className="row" style={{ marginTop: 8 }}>
          <input
            value={settings.model.workspaceDir}
            onChange={(e) => onModelChange({ workspaceDir: e.target.value })}
            placeholder={t("settings.general.workspacePlaceholder")}
          />
          <button className="btn" onClick={pickWorkspace}>
            {t("common.browse")}
          </button>
        </div>
        <p className="setting-hint">{t("settings.general.workspaceHint")}</p>
      </div>

      <div className="setting-card">
        <Toggle
          label={t("settings.general.openAtLogin")}
          desc={t("settings.general.openAtLoginDesc")}
          checked={settings.openAtLogin}
          onChange={(v) => onChange({ openAtLogin: v })}
        />
        <div className="setting-sep" />
        <Toggle
          label={t("settings.general.trayEnabled")}
          desc={t("settings.general.trayEnabledDesc")}
          checked={settings.trayEnabled}
          onChange={(v) => onChange({ trayEnabled: v })}
        />
        <div className="setting-sep" />
        <Toggle
          label={t("settings.general.keepAwake")}
          checked={settings.keepAwake}
          desc={t("settings.general.keepAwakeDesc")}
          onChange={(v) => onChange({ keepAwake: v })}
        />
        <div className="setting-sep" />
        <Toggle
          label={t("settings.general.showReasoning")}
          desc={t("settings.general.showReasoningDesc")}
          checked={settings.showReasoning}
          onChange={(v) => onChange({ showReasoning: v })}
        />
      </div>
    </div>
  );
}

export function Toggle({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): React.ReactElement {
  return (
    <div className="setting-row">
      <div>
        <div className="setting-label">{label}</div>
        {desc && <div className="setting-hint">{desc}</div>}
      </div>
      <button
        className={`switch ${checked ? "on" : ""}`}
        onClick={() => onChange(!checked)}
        role="switch"
        aria-checked={checked}
      >
        <span className="knob" />
      </button>
    </div>
  );
}
