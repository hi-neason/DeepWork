import { useEffect, useState } from "react";
import type {
  ConfiguredModel,
  ModelConfig,
  ProviderKind,
  Settings as SettingsType,
  VerifyResult,
} from "../../../../shared/types";
import {
  MODEL_CATALOG,
  PROVIDER_PRESETS,
} from "../../../../shared/providers";

interface Props {
  settings: SettingsType;
  apiKey: string;
  onApiKey: (k: string) => void;
  onChange: (patch: Partial<SettingsType["model"]>) => void;
  onSettingsChange: (patch: Partial<SettingsType>) => void;
}

export function ModelsTab({
  settings,
  apiKey,
  onApiKey,
  onChange,
  onSettingsChange,
}: Props): React.ReactElement {
  const [editing, setEditing] = useState<ConfiguredModel | null>(null);
  const [creating, setCreating] = useState(false);

  const configured = settings.configuredModels ?? [];
  // Ensure the active settings model is always represented in the list.
  const effectiveList = withActiveModel(settings, configured);

  const startCreate = (): void => {
    setEditing(null);
    setCreating(true);
  };
  const startEdit = (m: ConfiguredModel): void => {
    setCreating(false);
    setEditing(m);
  };
  const closeEditor = (): void => {
    setEditing(null);
    setCreating(false);
  };

  if (creating || editing) {
    return (
      <ModelEditor
        settings={settings}
        apiKey={apiKey}
        onApiKey={onApiKey}
        editing={editing}
        creating={creating}
        onChange={onChange}
        onSettingsChange={onSettingsChange}
        onClose={closeEditor}
      />
    );
  }

  const removeModel = (id: string): void => {
    onSettingsChange({
      configuredModels: configured.filter((m) => m.id !== id),
    });
  };

  const toggleModel = (id: string, enabled: boolean): void => {
    onSettingsChange({
      configuredModels: configured.map((m) =>
        m.id === id ? { ...m, enabled } : m,
      ),
    });
  };

  const setDefault = (m: ConfiguredModel): void => {
    onSettingsChange({
      configuredModels: configured.map((x) => ({
        ...x,
        isDefault: x.id === m.id,
      })),
      model: { ...settings.model, provider: m.provider, model: shortId(m.id) },
    });
  };

  return (
    <div className="settings-section">
      <h2>模型</h2>

      <h3>模型管理</h3>
      <p className="section-desc">
        配置 API key 并添加可用模型，勾选启用后会出现在输入框的模型选择器中。
      </p>

      <button className="btn primary add-model-btn" onClick={startCreate}>
        + 添加模型
      </button>

      <div className="info-banner">
        <span className="info-icon">i</span>
        添加的模型在本地 DeepWork 中使用，需要对应的 API key 或兼容端点。
      </div>

      {effectiveList.length === 0 ? (
        <div className="empty-models">
          还没有配置模型。点击「添加模型」开始。
        </div>
      ) : (
        <table className="model-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>服务商</th>
              <th className="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {effectiveList.map((m) => {
              const preset = PROVIDER_PRESETS[m.provider];
              const isDefault =
                m.isDefault ||
                (settings.model.provider === m.provider &&
                  settings.model.model === shortId(m.id) &&
                  !configured.some((x) => x.isDefault));
              return (
                <tr key={m.id}>
                  <td>
                    <span className="model-name">{shortId(m.id)}</span>
                    {isDefault && <span className="default-tag">默认</span>}
                  </td>
                  <td>{preset?.label ?? m.provider}</td>
                  <td className="col-actions">
                    <button
                      className="icon-btn"
                      title="编辑"
                      onClick={() => startEdit(m)}
                    >
                      ✎
                    </button>
                    <button
                      className="icon-btn"
                      title="删除"
                      onClick={() => removeModel(m.id)}
                    >
                      🗑
                    </button>
                    <label className="switch small" title="启用">
                      <input
                        type="checkbox"
                        checked={m.enabled}
                        onChange={(e) => toggleModel(m.id, e.target.checked)}
                      />
                      <span className="knob" />
                    </label>
                    {!isDefault && (
                      <button
                        className="btn small ghost"
                        onClick={() => setDefault(m)}
                      >
                        设为默认
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ---- editor ---- */

function ModelEditor({
  settings,
  apiKey,
  onApiKey,
  editing,
  creating,
  onChange,
  onSettingsChange,
  onClose,
}: {
  settings: SettingsType;
  apiKey: string;
  onApiKey: (k: string) => void;
  editing: ConfiguredModel | null;
  creating: boolean;
  onChange: (patch: Partial<ModelConfig>) => void;
  onSettingsChange: (patch: Partial<SettingsType>) => void;
  onClose: () => void;
}): React.ReactElement {
  const [provider, setProvider] = useState<ProviderKind>(
    editing?.provider ?? settings.model.provider,
  );
  const [modelId, setModelId] = useState(
    editing ? shortId(editing.id) : "",
  );
  const [baseUrl, setBaseUrl] = useState(settings.model.baseUrl ?? "");
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);

  const preset = PROVIDER_PRESETS[provider];
  const needsKey = provider !== "ollama";
  const suggestions = MODEL_CATALOG.filter((m) => m.provider === provider);

  // When switching provider, update base URL to preset default.
  useEffect(() => {
    if (creating) setBaseUrl(PROVIDER_PRESETS[provider]?.baseUrl ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const verify = async (): Promise<void> => {
    setVerifying(true);
    setResult(null);
    if (needsKey) await window.deepwork.settings.setKey(provider, apiKey.trim());
    const cfg: ModelConfig = {
      provider,
      model: modelId || preset.defaultModel,
      baseUrl: baseUrl || undefined,
      workspaceDir: settings.model.workspaceDir,
    };
    setResult(await window.deepwork.models.verify(cfg));
    setVerifying(false);
  };

  const save = (): void => {
    const id = modelId.trim() || preset.defaultModel;
    if (!id) return;
    if (needsKey && apiKey.trim()) {
      void window.deepwork.settings.setKey(provider, apiKey.trim());
    }
    const entry: ConfiguredModel = {
      id: `${provider}:${id}`,
      provider,
      enabled: editing?.enabled ?? true,
      isDefault: editing?.isDefault ?? settings.configuredModels.length === 0,
    };
    const others = settings.configuredModels.filter(
      (m) => m.id !== entry.id,
    );
    onSettingsChange({
      configuredModels: [...others, entry],
      model: {
        ...settings.model,
        provider,
        model: id,
        ...(baseUrl ? { baseUrl } : {}),
      },
    });
    onClose();
  };

  return (
    <div className="settings-section">
      <button className="back-btn" onClick={onClose}>
        ‹ 模型
      </button>
      <h2>{creating ? "添加模型" : "编辑模型"}</h2>

      <div className="setting-card">
        <div className="field">
          <label>服务商</label>
          <div className="provider-grid">
            {Object.values(PROVIDER_PRESETS).map((p) => (
              <button
                key={p.kind}
                className={`provider-chip ${provider === p.kind ? "active" : ""}`}
                onClick={() => setProvider(p.kind)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>模型 ID</label>
          <input
            list="deepwork-model-edit-list"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            placeholder={preset.defaultModel}
            spellCheck={false}
          />
          <datalist id="deepwork-model-edit-list">
            {suggestions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </datalist>
          <p className="setting-hint">
            可从建议中选择，或直接输入服务商支持的任意模型名称。
          </p>
        </div>

        {!needsKey ? (
          <div className="field">
            <label>Ollama 地址</label>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={preset.baseUrl}
            />
          </div>
        ) : (
          <div className="field">
            <label>
              {preset.label} API Key
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

        <div className="field">
          <label>Custom endpoint（可选）</label>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={preset.baseUrl || "https://api.example.com/v1"}
          />
          <p className="setting-hint">
            用于 OpenRouter、vLLM、火山 Ark 等 OpenAI 兼容服务；留空使用默认端点。
          </p>
        </div>

        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={verify} disabled={verifying}>
            {verifying ? "验证中…" : "测试连接"}
          </button>
          <button className="btn primary" onClick={save}>
            保存
          </button>
          {result && (
            <span style={{ color: result.ok ? "var(--ok)" : "var(--danger)" }}>
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
    </div>
  );
}

/* ---- helpers ---- */

function shortId(id: string): string {
  return id.includes(":") ? id.split(":").slice(1).join(":") : id;
}

/** Make sure the list always includes the active settings model. */
function withActiveModel(
  settings: SettingsType,
  configured: ConfiguredModel[],
): ConfiguredModel[] {
  const activeId = `${settings.model.provider}:${settings.model.model}`;
  if (configured.some((m) => m.id === activeId)) return configured;
  // Synthesize an entry for the active model so it appears in the list.
  return [
    ...configured,
    {
      id: activeId,
      provider: settings.model.provider,
      enabled: true,
      isDefault: true,
    },
  ];
}
