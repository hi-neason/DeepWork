import { useEffect, useState } from "react";
import type { UpdateStatus } from "../../../../shared/types";

interface Props {
  updateStatus: UpdateStatus;
}

const SHORTCUTS: Array<{ keys: string; desc: string }> = [
  { keys: "Enter", desc: "发送消息" },
  { keys: "Shift + Enter", desc: "换行" },
  { keys: "⌘ / Ctrl + N", desc: "新建任务" },
];

export function AboutTab({ updateStatus }: Props): React.ReactElement {
  const [dataPath, setDataPath] = useState("");

  useEffect(() => {
    void window.deepwork.app.dataPath().then(setDataPath);
  }, []);

  return (
    <div className="settings-section">
      <h2>关于</h2>

      <div className="setting-card">
        <div className="setting-row">
          <div>
            <div className="setting-label">版本</div>
            <div className="setting-hint">DeepWork v0.0.1 · local-first</div>
          </div>
        </div>
        <div className="setting-sep" />
        <div className="setting-row">
          <div>
            <div className="setting-label">数据存储位置</div>
            <div className="setting-hint mono">{dataPath || "~/DeepWork"}</div>
          </div>
          <button className="btn" onClick={() => window.deepwork.app.revealData()}>
            在 Finder 中显示
          </button>
        </div>
        <div className="setting-sep" />
        <div className="setting-row">
          <div>
            <div className="setting-label">更新</div>
            <div className="setting-hint">
              {updateStatus.state === "idle" && "尚未检查更新。"}
              {updateStatus.state === "checking" && "正在检查更新…"}
              {updateStatus.state === "available" && `有新版本：${updateStatus.version}`}
              {updateStatus.state === "downloading" && `下载中 ${updateStatus.percent}%`}
              {updateStatus.state === "downloaded" && `已下载 v${updateStatus.version}，重启以安装。`}
              {updateStatus.state === "error" && `更新失败：${updateStatus.message}`}
              {updateStatus.state === "not-available" && "已是最新版本。"}
            </div>
          </div>
          {updateStatus.state === "downloaded" && (
            <button className="btn primary" onClick={() => window.deepwork.updates.install()}>
              重启并更新
            </button>
          )}
          {updateStatus.state !== "downloaded" && (
            <button className="btn" onClick={() => window.deepwork.updates.check()}>
              检查更新
            </button>
          )}
        </div>
      </div>

      <h3 style={{ marginTop: 20 }}>快捷键</h3>
      <div className="setting-card">
        {SHORTCUTS.map((s, i) => (
          <div key={s.keys}>
            <div className="setting-row">
              <div className="setting-label">{s.desc}</div>
              <kbd className="kbd">{s.keys}</kbd>
            </div>
            {i < SHORTCUTS.length - 1 && <div className="setting-sep" />}
          </div>
        ))}
      </div>
    </div>
  );
}
