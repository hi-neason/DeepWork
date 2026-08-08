import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UpdateStatus } from "../../../../shared/types";

/** Project open-source repository (GitHub). */
const GITHUB_URL = "https://github.com/hi-neason/DeepWork";

interface Props {
  updateStatus: UpdateStatus;
}

export function AboutTab({ updateStatus }: Props): React.ReactElement {
  const { t } = useTranslation();
  const [dataPath, setDataPath] = useState("");

  useEffect(() => {
    void window.deepwork.app.dataPath().then(setDataPath);
  }, []);

  return (
    <div className="settings-section">
      <h2>{t("settings.about.title")}</h2>

      <div className="setting-card">
        <div className="setting-row">
          <div>
            <div className="setting-label">{t("settings.about.version")}</div>
            <div className="setting-hint">{t("settings.about.versionHint")}</div>
          </div>
        </div>
        <div className="setting-sep" />
        <div className="setting-row">
          <div>
            <div className="setting-label">{t("settings.about.dataLocation")}</div>
            <div className="setting-hint mono">{dataPath || "~/DeepWork"}</div>
          </div>
          <button className="btn" onClick={() => window.deepwork.app.revealData()}>
            {t("settings.about.showInFinder")}
          </button>
        </div>
        <div className="setting-sep" />
        <div className="setting-row">
          <div>
            <div className="setting-label">{t("settings.about.source")}</div>
            <div className="setting-hint">
              <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="about-link">
                {GITHUB_URL}
              </a>
            </div>
          </div>
        </div>
        <div className="setting-sep" />
        <div className="setting-row">
          <div>
            <div className="setting-label">{t("settings.about.update")}</div>
            <div className="setting-hint">
              {updateStatus.state === "idle" && t("settings.about.updateIdle")}
              {updateStatus.state === "checking" && t("settings.about.updateChecking")}
              {updateStatus.state === "available" &&
                t("settings.about.updateAvailable", { version: updateStatus.version })}
              {updateStatus.state === "downloading" &&
                t("settings.about.updateDownloading", { percent: updateStatus.percent })}
              {updateStatus.state === "downloaded" &&
                t("settings.about.updateDownloaded", { version: updateStatus.version })}
              {updateStatus.state === "error" &&
                t("settings.about.updateError", { message: updateStatus.message })}
              {updateStatus.state === "not-available" && t("settings.about.updateNotAvailable")}
            </div>
          </div>
          {updateStatus.state === "downloaded" && (
            <button className="btn primary" onClick={() => window.deepwork.updates.install()}>
              {t("settings.about.restartAndUpdate")}
            </button>
          )}
          {updateStatus.state !== "downloaded" && (
            <button className="btn" onClick={() => window.deepwork.updates.check()}>
              {t("settings.about.checkUpdate")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
