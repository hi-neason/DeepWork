import { useEffect, useMemo, useState } from "react";
import type {
  ConfiguredModel,
  ModelInfo,
  ProviderKind,
  Settings as SettingsType,
  VerifyResult,
} from "../../../../shared/types";
import {
  modelsForProvider,
  PROVIDER_PRESETS,
} from "../../../../shared/providers";

interface Props {
  settings: SettingsType;
  apiKey: string;
  onApiKey: (k: string) => void;
  onChange: (patch: Partial<SettingsType["model"]>) => void;
  onSettingsChange: (patch: Partial<SettingsType>) => void;
}

type ConnectionState = "idle" | "testing" | "connected" | "failed";

export function ModelsTab({
  settings,
  apiKey,
  onApiKey,
  onChange,
  onSettingsChange,
}: Props): React.ReactElement {
  const [provider, setProvider] = useState<ProviderKind>(settings.model.provider);
  const [catalog, setCatalog] = useState<ModelInfo[]>([]);
  const [state, setState] = useState<ConnectionState>("idle");
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [newModel, setNewModel] = useState("");

  useEffect(() => {
    void window.deepwork.models.catalog().then(setCatalog);
  }, []);

  useEffect(() => {
    setProvider(settings.model.provider);
    setState("idle");
    setResult(null);
  }, [settings.model.provider]);

  const preset = PROVIDER_PRESETS[provider];
  const needsKey = provider !== "ollama";
  const isOllama = provider === "ollama";

  // Configured models for this provider, plus catalog suggestions not yet added.
  const configuredForProvider = useMemo(
    () => settings.configuredModels.filter((m) => m.provider === provider),
    [settings.configuredModels, provider],
  );
  const configuredIds = new Set(configuredForProvider.map((m) => m.id));
  const suggestions = useMemo(
    () =>
      modelsForProvider(provider).filter((m) => !configuredIds.has(m.id)),
    [provider, configuredIds],
  );

  // The model config being edited. If the user picked a different provider
  // than the active one, use an in-memory draft until they save.
  const modelConfig =
    settings.model.provider === provider
      ? settings.model
      : {
          ...settings.model,
          provider,
          baseUrl: preset.baseUrl,
          model:
            configuredForProvider.find((m) => m.isDefault)?.id ??
            preset.defaultModel,
        };

  const selectProvider = (p: ProviderKind): void => {
    setProvider(p);
    setState("idle");
    setResult(null);
    // Persist the provider switch so save/apply uses it.
    const pre = PROVIDER_PRESETS[p];
    onChange({
      provider: p,
      baseUrl: pre.baseUrl,
      model:
        settings.configuredModels.find((m) => m.provider === p && m.isDefault)?.id ??
        pre.defaultModel,
    });
  };

  const patchSettings = (models: ConfiguredModel[]): void => {
    onSettingsChange({ configuredModels: models });
  };

  const upsertModel = (id: string, patch?: Partial<ConfiguredModel>): void => {
    const all = settings.configuredModels.filter(
      (m) => !(m.provider === provider && m.id === id),
    );
    const current = settings.configuredModels.find(
      (m) => m.provider === provider && m.id === id,
    );
    all.push({
      id,
      provider,
      enabled: current?.enabled ?? true,
      isDefault: current?.isDefault,
      ...patch,
    });
    patchSettings(all);
  };

  const removeModel = (id: string): void => {
    const all = settings.configuredModels.filter(
      (m) => !(m.provider === provider && m.id === id),
    );
    patchSettings(all);
  };

  const setDefault = (id: string): void => {
    const all = settings.configuredModels.map((m) =>
      m.provider === provider ? { ...m, isDefault: m.id === id } : m,
    );
    patchSettings(all);
    onChange({ model: id });
  };

  const toggleEnabled = (id: string, enabled: boolean): void => {
    upsertModel(id, { enabled });
  };

  const addModel = (): void => {
    const id = newModel.trim();
    if (!id || configuredIds.has(id)) return;
    const all = [
      ...settings.configuredModels,
      { id, provider, enabled: true, isDefault: configuredForProvider.length === 0 },
    ];
    patchSettings(all);
    if (configuredForProvider.length === 0) onChange({ model: id });
    setNewModel("");
  };

  const runTest = async (): Promise<void> => {
    setState("testing");
    setResult(null);
    if (needsKey) await window.deepwork.settings.setKey(provider, apiKey.trim());
    const r = await window.deepwork.models.verify({
      provider,
      model: modelConfig.model,
      baseUrl: modelConfig.baseUrl,
      workspaceDir: settings.model.workspaceDir,
    });
    setResult(r);
    if (r.ok) {
      setState("connected");
      // Auto-add verified/reported models for this provider (deduped).
      if (r.models && r.models.length) {
        const existing = new Set(settings.configuredModels.map((m) => `${m.provider}:${m.id}`));
        const added: ConfiguredModel[] = [];
        for (const id of r.models) {
          if (!existing.has(`${provider}:${id}`)) {
            added.push({
              id,
              provider,
              enabled: added.length < 8,
              isDefault: settings.configuredModels.filter((m) => m.provider === provider).length === 0 && added.length === 0,
            });
          }
        }
        if (added.length) {
          onSettingsChange({ configuredModels: [...settings.configuredModels, ...added] });
        }
      }
    } else {
      setState("failed");
    }
  };

  const removeKey = async (): Promise<void> => {
    await window.deepwork.settings.setKey(provider, "");
    onApiKey("");
    setState("idle");
    setResult(null);
  };

  const connected = state === "connected" || (result?.ok && state !== "failed");

  return (
    <div className="settings-section">
      <h2>模型</h2>
      <p className="section-desc">配置提供方、密钥和可用模型。勾选的模型会出现在输入框的模型选择器中。</p>

      <div className="setting-card">
        <div className="provider-picker">
          <div className="provider-current">
            <span className="provider-name">{preset.label}</span>
            {connected ? (
              <span className="conn-ok">✓ Connected</span>
            ) : state === "failed" ? (
              <span className="conn-err">Connection failed</span>
            ) : null}
          </div>
          <div className="provider-grid compact">
            {Object.values(PROVIDER_PRESETS).map((p) => (
              <button
                key={p.kind}
                className={`provider-chip ${provider === p.kind ? "active" : ""}`}
                onClick={() => selectProvider(p.kind)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {needsKey && (
        <div className="setting-card">
          <div className="setting-label" style={{ marginBottom: 8 }}>{preset.label} API key</div>
          <div className="row" style={{ alignItems: "stretch" }}>
            <div className={`key-input ${connected ? "saved" : ""} ${state === "failed" ? "err" : ""}`}>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => {
                  onApiKey(e.target.value);
                  setState("idle");
                }}
                placeholder={preset.keyPlaceholder}
              />
              {connected && <span className="badge ok">✓ Tested &amp; saved</span>}
            </div>
            <button className="btn" onClick={runTest} disabled={state === "testing"}>
              {state === "testing" ? "Testing…" : "Test"}
            </button>
          </div>
          {result && !result.ok && (
            <div className="setting-hint" style={{ color: "var(--danger)", marginTop: 8 }}>
              ✕ {result.message}
            </div>
          )}
          {preset.envKey && (
            <div className="setting-hint">
              也可通过环境变量 {preset.envKey} 提供；留空则使用已保存的密钥。
            </div>
          )}
          {apiKey && (
            <button className="link-danger" onClick={removeKey}>Remove key…</button>
          )}
        </div>
      )}

      {!isOllama && (
        <div className="setting-card">
          <div className="setting-label" style={{ marginBottom: 8 }}>Custom endpoint (可选)</div>
          <input
            value={modelConfig.baseUrl ?? ""}
            onChange={(e) => onChange({ baseUrl: e.target.value })}
            placeholder={preset.baseUrl || "https://api.example.com/v1"}
          />
          <p className="setting-hint">
            用于 Azure OpenAI、OpenRouter、vLLM 或任何 OpenAI 兼容服务。留空使用默认端点。
          </p>
        </div>
      )}

      {isOllama && (
        <div className="setting-card">
          <div className="setting-label" style={{ marginBottom: 8 }}>Ollama 地址</div>
          <input
            value={modelConfig.baseUrl ?? ""}
            onChange={(e) => onChange({ baseUrl: e.target.value })}
            placeholder={preset.baseUrl}
          />
        </div>
      )}

      <h3>MODELS</h3>
      <p className="section-desc">勾选的模型会显示在输入框的模型选择器中；default 标记为新会话的默认模型。</p>

      <div className="setting-card">
        {configuredForProvider.length === 0 && suggestions.length === 0 && (
          <p className="setting-hint">还没有模型。先 Test 连接以自动获取，或在下方手动添加。</p>
        )}

        {configuredForProvider.map((m) => {
          const info = catalog.find((c) => c.id === m.id);
          return (
            <div key={m.id} className="model-row">
              <label className="model-check">
                <input
                  type="checkbox"
                  checked={m.enabled}
                  onChange={(e) => toggleEnabled(m.id, e.target.checked)}
                />
                <span>{info?.label ?? m.id}</span>
              </label>
              <div className="model-actions">
                {m.isDefault ? (
                  <span className="default-badge">default</span>
                ) : (
                  <button className="btn small ghost" onClick={() => setDefault(m.id)}>
                    设为默认
                  </button>
                )}
                <button
                  className="icon-btn"
                  title="Remove"
                  onClick={() => removeModel(m.id)}
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })}

        {suggestions.length > 0 && (
          <>
            <div className="setting-sep" />
            <div className="setting-hint">推荐模型</div>
            {suggestions.map((m) => (
              <div key={m.id} className="model-row">
                <label className="model-check">
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={() => upsertModel(m.id, { enabled: true })}
                  />
                  <span>
                    {m.label}
                    {m.recommended ? " ★" : ""}
                  </span>
                </label>
                <span className="model-tags">
                  {m.vision && <em>👁</em>}
                  <em>{Math.round(m.contextWindow / 1000)}k</em>
                </span>
              </div>
            ))}
          </>
        )}

        <div className="setting-sep" />
        <div className="row">
          <input
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addModel()}
            placeholder="Add another model…"
          />
          <button className="btn primary" onClick={addModel}>
            Add
          </button>
        </div>
      </div>

      <div className="setting-card">
        <div className="setting-label">工作区目录</div>
        <div className="row" style={{ marginTop: 8 }}>
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
        <p className="setting-hint">未在新建任务时指定文件夹的会话将使用此目录。</p>
      </div>
    </div>
  );
}
