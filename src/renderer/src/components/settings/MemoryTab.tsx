import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";

type MemSubTab = "user" | "timeline" | "project";

export function MemoryTab(): React.ReactElement {
  const { t } = useTranslation();
  const [sub, setSub] = useState<MemSubTab>("user");

  return (
    <div className="settings-section">
      <h2>{t("settings.memory.title")}</h2>
      <p className="section-desc">{t("settings.memory.desc")}</p>

      <div className="mem-tabs">
        <button
          className={`mem-tab ${sub === "user" ? "active" : ""}`}
          onClick={() => setSub("user")}
        >
          {t("settings.memory.tabs.user")}
        </button>
        <button
          className={`mem-tab ${sub === "timeline" ? "active" : ""}`}
          onClick={() => setSub("timeline")}
        >
          {t("settings.memory.tabs.timeline")}
        </button>
        <button
          className={`mem-tab ${sub === "project" ? "active" : ""}`}
          onClick={() => setSub("project")}
        >
          {t("settings.memory.tabs.project")}
        </button>
      </div>

      {sub === "user" ? (
        <UserMemoryEditor />
      ) : sub === "timeline" ? (
        <TimelineViewer />
      ) : (
        <ProjectMemoryViewer />
      )}
    </div>
  );
}

function UserMemoryEditor(): React.ReactElement {
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
    <div className="setting-card">
      <h3 className="um-heading">{t("settings.memory.heading")}</h3>

      <p className="setting-hint um-edit-hint">{t("settings.memory.editHint")}</p>

      <textarea
        className="um-editor"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
      />

      <div className="um-actions">
        <div className="um-buttons">
          <button
            className={`btn primary ${saving ? "disabled" : ""}`}
            onClick={() => void save()}
            disabled={saving || !dirty}
          >
            {t("common.save")}
          </button>
          <button className="btn" onClick={reset} disabled={saving || !dirty}>
            {t("common.cancel")}
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
        <div className="um-path-hint">
          <span className="um-path-label">{t("settings.memory.fileLabel")}</span>
          <code className="um-path-value">{memoryPath}</code>
        </div>
      </div>
    </div>
  );
}

function TimelineViewer(): React.ReactElement {
  const { t } = useTranslation();
  const [dates, setDates] = useState<string[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [filePath, setFilePath] = useState("");

  useEffect(() => {
    void (async () => {
      const list = await window.deepwork.timeline.list();
      setDates(list);
      if (list.length) setSel(list[0]);
    })();
  }, []);

  useEffect(() => {
    if (!sel) {
      setContent("");
      setFilePath("");
      return;
    }
    void (async () => {
      setContent(await window.deepwork.timeline.read(sel));
      setFilePath(await window.deepwork.timeline.path(sel));
    })();
  }, [sel]);

  if (dates.length === 0) {
    return (
      <div className="setting-card">
        <p className="setting-hint tl-empty">{t("settings.memory.timeline.empty")}</p>
      </div>
    );
  }

  return (
    <div className="setting-card tl-layout">
      <ul className="tl-list">
        {dates.map((d) => (
          <li
            key={d}
            className={`tl-item ${sel === d ? "active" : ""}`}
            onClick={() => setSel(d)}
          >
            {d}
          </li>
        ))}
      </ul>
      <div className="tl-detail">
        <div className="tl-path-hint">
          <span className="um-path-label">{t("settings.memory.fileLabel")}</span>
          <code className="um-path-value">{filePath}</code>
        </div>
        <pre className="tl-content">
          {content || t("settings.memory.timeline.dateEmpty")}
        </pre>
      </div>
    </div>
  );
}

function ProjectMemoryViewer(): React.ReactElement {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<string[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [filePath, setFilePath] = useState("");

  useEffect(() => {
    void (async () => {
      const list = await window.deepwork.projectMemory.list();
      setProjects(list);
      if (list.length) setSel(list[0]);
    })();
  }, []);

  useEffect(() => {
    if (!sel) {
      setContent("");
      setFilePath("");
      return;
    }
    void (async () => {
      setContent(await window.deepwork.projectMemory.read(sel));
      setFilePath(await window.deepwork.projectMemory.path(sel));
    })();
  }, [sel]);

  if (projects.length === 0) {
    return (
      <div className="setting-card">
        <p className="setting-hint tl-empty">{t("settings.memory.project.empty")}</p>
      </div>
    );
  }

  return (
    <div className="setting-card tl-layout">
      <ul className="tl-list">
        {projects.map((p) => (
          <li
            key={p}
            className={`tl-item ${sel === p ? "active" : ""}`}
            onClick={() => setSel(p)}
          >
            {p}
          </li>
        ))}
      </ul>
      <div className="tl-detail">
        <div className="tl-path-hint">
          <span className="um-path-label">{t("settings.memory.fileLabel")}</span>
          <code className="um-path-value">{filePath}</code>
        </div>
        <pre className="tl-content">
          {content || t("settings.memory.project.projectEmpty")}
        </pre>
      </div>
    </div>
  );
}
