import type { Settings } from "../../../../shared/types";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onModelChange: (patch: Partial<Settings["model"]>) => void;
}

export function GeneralTab({ settings, onChange, onModelChange }: Props): React.ReactElement {
  const pickWorkspace = async (): Promise<void> => {
    const dir = await window.deepwork.settings.pickDirectory();
    if (dir) onModelChange({ workspaceDir: dir });
  };
  return (
    <div className="settings-section">
      <h2>通用</h2>
      <p className="section-desc">DeepWork 在这台机器上的外观和行为。</p>

      <div className="setting-card">
        <div className="setting-head">主题</div>
        <div className="segmented">
          {(["light", "dark", "auto"] as const).map((t) => (
            <button
              key={t}
              className={settings.theme === t ? "active" : ""}
              onClick={() => onChange({ theme: t })}
            >
              {t === "light" ? "浅色" : t === "dark" ? "深色" : "跟随系统"}
            </button>
          ))}
        </div>
        <p className="setting-hint">跟随系统会自动匹配你 Mac 的外观。</p>
      </div>

      <div className="setting-card">
        <div className="setting-row">
          <div>
            <div className="setting-label">界面语言</div>
            <div className="setting-hint">切换界面显示语言。</div>
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
            <div className="setting-label">字体大小</div>
            <div className="setting-hint">调整界面文字大小。</div>
          </div>
          <div className="slider-wrap">
            <span>小</span>
            <input
              type="range"
              min={0.9}
              max={1.3}
              step={0.05}
              value={settings.fontScale}
              onChange={(e) => onChange({ fontScale: Number(e.target.value) })}
            />
            <span>大</span>
          </div>
        </div>
      </div>

      <div className="setting-card">
        <div className="setting-label">默认工作区目录</div>
        <div className="row" style={{ marginTop: 8 }}>
          <input
            value={settings.model.workspaceDir}
            onChange={(e) => onModelChange({ workspaceDir: e.target.value })}
            placeholder="默认为 ~/DeepWork/workspace"
          />
          <button className="btn" onClick={pickWorkspace}>
            浏览
          </button>
        </div>
        <p className="setting-hint">未在新建任务时指定文件夹的会话将使用此目录。</p>
      </div>

      <div className="setting-card">
        <Toggle
          label="开机时自动启动"
          desc="登录系统后自动启动 DeepWork。"
          checked={settings.openAtLogin}
          onChange={(v) => onChange({ openAtLogin: v })}
        />
        <div className="setting-sep" />
        <Toggle
          label="关闭窗口时驻留托盘"
          desc="关闭窗口后保持后台运行，便于定时任务和接收通知。"
          checked={settings.trayEnabled}
          onChange={(v) => onChange({ trayEnabled: v })}
        />
        <div className="setting-sep" />
        <Toggle
          label="运行时防止休眠"
          desc="长任务或自动化运行期间保持电脑唤醒、屏幕不关闭。"
          checked={settings.keepAwake}
          onChange={(v) => onChange({ keepAwake: v })}
        />
        <div className="setting-sep" />
        <Toggle
          label="显示思考过程"
          desc="在回答中展示模型的 reasoning/thinking 内容。"
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
