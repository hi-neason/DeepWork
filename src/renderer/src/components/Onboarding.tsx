import { useEffect, useMemo, useState } from "react";
import type {
  ModelConfig,
  ProviderKind,
  Settings as SettingsType,
  VerifyResult,
} from "../../../shared/types";
import { modelsForProvider, PROVIDER_PRESETS } from "../../../shared/providers";

interface Props {
  settings: SettingsType;
  onDone: () => void;
}

export function Onboarding({ settings, onDone }: Props): React.ReactElement {
  const [provider, setProvider] = useState<ProviderKind>(settings.model.provider);
  const [model, setModel] = useState(settings.model.model);
  const [baseUrl, setBaseUrl] = useState(settings.model.baseUrl ?? "");
  const [key, setKey] = useState("");
  const [workspace, setWorkspace] = useState(settings.model.workspaceDir);
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);

  const preset = PROVIDER_PRESETS[provider];
  const models = useMemo(() => modelsForProvider(provider), [provider]);

  useEffect(() => {
    if (!model || !models.some((m) => m.id === model)) {
      setModel(preset.defaultModel);
    }
    if (provider !== "custom" && !baseUrl) setBaseUrl(preset.baseUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const needsKey = provider !== "ollama";
  const showBaseUrl =
    provider === "ollama" || provider === "openai" ||
    provider === "custom" || provider === "openrouter";

  const verify = async (): Promise<void> => {
    setVerifying(true);
    setResult(null);
    const cfg: ModelConfig = {
      provider,
      model: model || preset.defaultModel,
      baseUrl: baseUrl || preset.baseUrl,
      workspaceDir: workspace,
    };
    if (needsKey) await window.deepwork.settings.setKey(provider, key.trim());
    setResult(await window.deepwork.models.verify(cfg));
    setVerifying(false);
  };

  const saveAndFinish = async (): Promise<void> => {
    const updated: SettingsType = {
      ...settings,
      model: {
        provider,
        model: model || preset.defaultModel,
        baseUrl: baseUrl || preset.baseUrl,
        workspaceDir: workspace,
      },
      onboarded: true,
    };
    await window.deepwork.settings.save(updated);
    if (needsKey) await window.deepwork.settings.setKey(provider, key.trim());
    await window.deepwork.settings.rebuildAgent();
    onDone();
  };

  const pickWorkspace = async (): Promise<void> => {
    const dir = await window.deepwork.settings.pickDirectory();
    if (dir) setWorkspace(dir);
  };

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div className="onboarding-brand">DeepWork</div>
        <h1>Welcome</h1>
        <p className="onboarding-sub">
          A local-first desktop AI agent. Choose a model and a workspace to get started.
        </p>

        <div className="field">
          <label>Model provider</label>
          <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderKind)}>
            {Object.values(PROVIDER_PRESETS).map((p) => (
              <option key={p.kind} value={p.kind}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Model</label>
          {models.length > 0 && (
            <select
              value={models.some((m) => m.id === model) ? model : ""}
              onChange={(e) => setModel(e.target.value)}
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
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={preset.defaultModel}
          />
        </div>

        {showBaseUrl && (
          <div className="field">
            <label>{provider === "ollama" ? "Ollama URL" : "Base URL"}</label>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={preset.baseUrl}
            />
          </div>
        )}

        {needsKey && (
          <div className="field">
            <label>
              {preset.label} API key
              {preset.envKey ? ` (or set ${preset.envKey})` : ""}
            </label>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={preset.keyPlaceholder}
            />
          </div>
        )}

        <div className="field">
          <label>Workspace directory</label>
          <div className="row">
            <input
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder="defaults to your home directory"
            />
            <button className="btn" onClick={pickWorkspace}>
              Browse
            </button>
          </div>
        </div>

        <div className="onboarding-actions">
          <button className="btn" onClick={verify} disabled={verifying}>
            {verifying ? "Verifying…" : "Test connection"}
          </button>
          <button className="btn primary" onClick={saveAndFinish} disabled={verifying}>
            Continue →
          </button>
        </div>

        {result && (
          <div className={`verify-result ${result.ok ? "ok" : "err"}`}>
            {result.ok ? "✓ " : "✕ "}
            {result.message}
            {result.models && result.models.length > 0 && (
              <div className="verify-models">
                {result.models.slice(0, 6).join(", ")}
                {result.models.length > 6 ? "…" : ""}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
