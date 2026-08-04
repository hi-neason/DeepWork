import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
  onChange: (patch: Partial<SettingsType["model"]>) => void;
  onSettingsChange: (patch: Partial<SettingsType>) => void;
}

export function ModelsTab({
  settings,
  onChange,
  onSettingsChange,
}: Props): React.ReactElement {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<ConfiguredModel | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ConfiguredModel | null>(null);

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
        editing={editing}
        creating={creating}
        onChange={onChange}
        onSettingsChange={onSettingsChange}
        onClose={closeEditor}
      />
    );
  }

  const removeModel = (id: string): void => {
    const remaining = configured.filter((m) => m.id !== id);
    const patch: Partial<SettingsType> = { configuredModels: remaining };
    const activeId = `${settings.model.provider}:${settings.model.model}`;
    // If the deleted model is the one currently in use, reassign the active
    // slot to the first remaining model so it doesn't get re-injected by
    // withActiveModel() and appear "undeletable".
    if (activeId === id && remaining.length > 0) {
      const next = remaining[0];
      patch.model = {
        ...settings.model,
        provider: next.provider,
        model: shortId(next.id),
      };
      patch.configuredModels = remaining.map((x, i) => ({
        ...x,
        isDefault: i === 0,
      }));
    }
    onSettingsChange(patch);
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
      <h2>{t("settings.models.title")}</h2>

      <h3>{t("settings.models.manage")}</h3>
      <p className="section-desc">{t("settings.models.manageDesc")}</p>

      <button className="btn secondary add-model-btn" onClick={startCreate}>
        {t("settings.models.addModel")}
      </button>

      <div className="info-banner">
        <span className="info-icon">i</span>
        {t("settings.models.infoBanner")}
      </div>

      {effectiveList.length === 0 ? (
        <div className="empty-models">{t("settings.models.empty")}</div>
      ) : (
        <table className="model-table">
          <thead>
            <tr>
              <th>{t("settings.models.colModel")}</th>
              <th>{t("settings.models.colProvider")}</th>
              <th className="col-actions">{t("settings.models.colActions")}</th>
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
                    {isDefault && <span className="default-tag">{t("settings.models.defaultTag")}</span>}
                  </td>
                  <td>{preset?.label ?? m.provider}</td>
                  <td className="col-actions">
                    <button
                      className="icon-btn"
                      title={t("settings.models.edit")}
                      onClick={() => startEdit(m)}
                    >
                      ✎
                    </button>
                    <button
                      className="icon-btn"
                      title={
                        effectiveList.length <= 1
                          ? t("settings.models.deleteDisabled")
                          : t("settings.models.delete")
                      }
                      disabled={effectiveList.length <= 1}
                      onClick={() => effectiveList.length > 1 && setPendingDelete(m)}
                    >
                      🗑
                    </button>
                    <label className="switch small" title={t("settings.models.enable")}>
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
                        {t("settings.models.setDefault")}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {pendingDelete && (
        <div
          className="overlay"
          onClick={() => setPendingDelete(null)}
          role="presentation"
        >
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog">
            <h3>{t("settings.models.confirmDeleteTitle")}</h3>
            <p style={{ color: "var(--text-dim)", fontSize: 13, marginTop: 4 }}>
              {t("settings.models.confirmDeleteBody", {
                name: shortId(pendingDelete.id),
              })}
            </p>
            <div className="actions">
              <button className="btn" onClick={() => setPendingDelete(null)}>
                {t("common.cancel")}
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  removeModel(pendingDelete.id);
                  setPendingDelete(null);
                }}
              >
                {t("common.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- editor ---- */

function ModelEditor({
  settings,
  editing,
  creating,
  onChange,
  onSettingsChange,
  onClose,
}: {
  settings: SettingsType;
  editing: ConfiguredModel | null;
  creating: boolean;
  onChange: (patch: Partial<ModelConfig>) => void;
  onSettingsChange: (patch: Partial<SettingsType>) => void;
  onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [provider, setProvider] = useState<ProviderKind>(
    editing?.provider ?? settings.model.provider,
  );
  const [modelId, setModelId] = useState(
    editing ? shortId(editing.id) : "",
  );
  const [baseUrl, setBaseUrl] = useState(settings.model.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);

  const preset = PROVIDER_PRESETS[provider];
  const needsKey = provider !== "ollama";
  const suggestions = MODEL_CATALOG.filter((m) => m.provider === provider);

  // Load the saved key for the current provider when it changes.
  useEffect(() => {
    let cancelled = false;
    setApiKey("");
    setShowKey(false);
    if (!needsKey) {
      setHasStoredKey(false);
      return;
    }
    void window.deepwork.settings.getKey(provider).then((k: string) => {
      if (cancelled) return;
      setHasStoredKey(Boolean(k));
    });
    return () => {
      cancelled = true;
    };
  }, [provider, needsKey]);

  // When switching provider, update base URL to preset default.
  useEffect(() => {
    if (creating) setBaseUrl(PROVIDER_PRESETS[provider]?.baseUrl ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const verify = async (): Promise<void> => {
    setVerifying(true);
    setResult(null);
    if (needsKey && apiKey.trim()) {
      await window.deepwork.settings.setKey(provider, apiKey.trim());
      setHasStoredKey(true);
    }
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

  const clearKey = (): void => {
    void window.deepwork.settings.setKey(provider, "");
    setApiKey("");
    setHasStoredKey(false);
  };

  return (
    <div className="settings-section">
      <button className="back-btn" onClick={onClose}>
        {t("settings.models.backToModels")}
      </button>
      <h2>{creating ? t("settings.models.addTitle") : t("settings.models.editTitle")}</h2>

      <div className="setting-card">
        <div className="field">
          <label>{t("settings.models.provider")}</label>
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
          <label>{t("settings.models.modelId")}</label>
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
          <p className="setting-hint">{t("settings.models.modelIdHint")}</p>
        </div>

        {!needsKey ? (
          <div className="field">
            <label>{t("settings.models.ollamaAddress")}</label>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={preset.baseUrl}
            />
          </div>
        ) : (
          <div className="field">
            <label>
              {preset.label} {t("settings.models.apiKey")}
              {preset.envKey ? t("settings.models.envKeyHint", { envKey: preset.envKey }) : ""}
            </label>
            <div className="key-input-row">
              <input
                type={showKey ? "text" : "password"}
                value={
                  apiKey ||
                  (hasStoredKey && !showKey ? "••••••••••••••••" : "")
                }
                onChange={(e) => {
                  setApiKey(e.target.value);
                  if (hasStoredKey) setHasStoredKey(false);
                }}
                onFocus={() => {
                  if (hasStoredKey && !apiKey) setShowKey(true);
                }}
                placeholder={hasStoredKey ? "" : preset.keyPlaceholder}
                autoComplete="off"
              />
              {hasStoredKey && (
                <button
                  type="button"
                  className="btn small ghost"
                  onClick={clearKey}
                  title={t("settings.models.clearSavedKey")}
                >
                  {t("common.clear")}
                </button>
              )}
            </div>
            {hasStoredKey && (
              <p className="setting-hint">{t("settings.models.keySavedHint")}</p>
            )}
          </div>
        )}

        <div className="field">
          <label>{t("settings.models.customEndpoint")}</label>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={preset.baseUrl || "https://api.example.com/v1"}
          />
          <p className="setting-hint">{t("settings.models.customEndpointHint")}</p>
        </div>

        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={verify} disabled={verifying}>
            {verifying ? t("settings.models.verifying") : t("settings.models.testConnection")}
          </button>
          <button className="btn primary" onClick={save}>
            {t("common.save")}
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
            {t("settings.models.availableModels")}
            {result.models.slice(0, 8).join(", ")}
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
