import { useEffect, useState } from "react";
import type { ModelInfo, ProviderKind, Settings as SettingsType, VerifyResult } from "../../../../shared/types";
import {
  modelsForProvider,
  PROVIDER_PRESETS,
} from "../../../../shared/providers";

interface Props {
  settings: SettingsType;
  apiKey: string;
  onApiKey: (k: string) => void;
  onChange: (patch: Partial<SettingsType["model"]>) => void;
}

export function ModelsTab({ settings, apiKey, onApiKey, onChange }: Props): React.ReactElement {
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [catalog, setCatalog] = useState<ModelInfo[]>([]);

  useEffect(() => {
    void window.deepwork.models.catalog().then(setCatalog);
  }, []);

  const preset = PROVIDER_PRESETS[settings.model.provider];
  const models = modelsForProvider(settings.model.provider);
  const needsKey = settings.model.provider !== "ollama";
  const showBaseUrl =
    settings.model.provider !== "ollama";
  const isOllama = settings.model.provider === "ollama";

  const verify = async (): Promise<void> => {
    setVerifying(true);
    setResult(null);
    if (needsKey) await window.deepwork.settings.setKey(settings.model.provider, apiKey.trim());
    setResult(await window.deepwork.models.verify(settings.model));
    setVerifying(false);
  };

  return (
    <div className="settings-section">
      <h2>模型</h2>
      <p className="section-desc">配置 DeepWork 使用的模型提供方和密钥。</p>

      <div className="setting-card">
        <div className="field">
          <label>提供方</label>
          <div className="provider-grid">
            {Object.values(PROVIDER_PRESETS).map((p) => (
              <button
                key={p.kind}
                className={`provider-chip ${settings.model.provider === p.kind ? "active" : ""}`}
                onClick={() => {
                  onChange({
                    provider: p.kind as ProviderKind,
                    model: p.defaultModel || settings.model.model,
                    baseUrl: p.baseUrl,
                  });
                  setResult(null);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>模型</label>
          {models.length > 0 && (
            <select
              value={models.some((m) => m.id === settings.model.model) ? settings.model.model : ""}
              onChange={(e) => onChange({ model: e.target.value })}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.recommended ? " ★" : ""}
                </option>
              ))}
            </select>
          )}
          <input
            style={{ marginTop: 8 }}
            value={settings.model.model}
            onChange={(e) => onChange({ model: e.target.value })}
            placeholder={preset.defaultModel}
          />
        </div>

        {isOllama ? (
          <div className="field">
            <label>Ollama 地址</label>
            <input
              value={settings.model.baseUrl ?? ""}
              onChange={(e) => onChange({ baseUrl: e.target.value })}
              placeholder={preset.baseUrl}
            />
          </div>
        ) : showBaseUrl ? (
          <div className="field">
            <label>Base URL</label>
            <input
              value={settings.model.baseUrl ?? ""}
              onChange={(e) => onChange({ baseUrl: e.target.value })}
              placeholder={preset.baseUrl}
            />
          </div>
        ) : null}

        {needsKey && (
          <div className="field">
            <label>
              API Key
              {preset.envKey ? `（也可通过环境变量 ${preset.envKey} 提供）` : ""}
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => onApiKey(e.target.value)}
              placeholder={preset.keyPlaceholder}
            />
          </div>
        )}

        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={verify} disabled={verifying}>
            {verifying ? "验证中…" : "测试连接"}
          </button>
          {result && (
            <span style={{ color: result.ok ? "var(--ok)" : "var(--danger)", fontSize: 13 }}>
              {result.ok ? "✓ " : "✕ "}
              {result.message}
            </span>
          )}
        </div>
        {result?.models && result.models.length > 0 && (
          <div className="setting-hint" style={{ marginTop: 8 }}>
            可用模型：{result.models.slice(0, 8).join(", ")}
            {result.models.length > 8 ? "…" : ""}
          </div>
        )}
      </div>

      <div className="setting-card">
        <div className="field">
          <label>工作区目录</label>
          <div className="row">
            <input
              value={settings.model.workspaceDir}
              onChange={(e) => onChange({ workspaceDir: e.target.value })}
              placeholder="默认为 ~/DeepWork/workspace"
            />
            <button
              className="btn"
              onClick={async () => {
                const dir = await window.deepwork.settings.pickDirectory();
                if (dir) onChange({ workspaceDir: dir });
              }}
            >
              浏览
            </button>
          </div>
          <p className="setting-hint">
            未在新建任务时指定文件夹的会话将使用此目录。
          </p>
        </div>
      </div>

      <details className="setting-card">
        <summary className="setting-label">模型目录（{catalog.length}）</summary>
        <div className="model-matrix">
          {catalog
            .filter((m) => m.provider === settings.model.provider)
            .map((m) => (
              <div key={m.id} className="model-row">
                <span>{m.label}</span>
                <span className="model-tags">
                  {m.vision && <em>👁 vision</em>}
                  <em>{Math.round(m.contextWindow / 1000)}k</em>
                  {m.recommended && <em>★</em>}
                </span>
              </div>
            ))}
        </div>
      </details>
    </div>
  );
}
