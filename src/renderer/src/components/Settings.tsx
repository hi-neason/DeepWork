import { useEffect, useMemo, useState } from "react";
import type {
  McpServerConfig,
  MemoryItem,
  Settings as SettingsType,
  VerifyResult,
} from "../../../shared/types";
import {
  modelsForProvider,
  PROVIDER_PRESETS,
} from "../../../shared/providers";

interface Props {
  onClose: () => void;
}

export function Settings({ onClose }: Props): React.ReactElement {
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [newMemory, setNewMemory] = useState("");

  useEffect(() => {
    void (async () => {
      const s = await window.deepwork.settings.get();
      setSettings(s);
      setApiKey(await window.deepwork.settings.getKey(s.model.provider));
      setMemories(await window.deepwork.memories.list());
    })();
  }, []);

  const models = useMemo(
    () => (settings ? modelsForProvider(settings.model.provider) : []),
    [settings],
  );

  if (!settings) return <div className="settings">Loading…</div>;

  const preset = PROVIDER_PRESETS[settings.model.provider];
  const needsKey = settings.model.provider !== "ollama";
  const needsBaseUrl =
    settings.model.provider !== "ollama" &&
    (settings.model.provider === "openai" ||
      settings.model.provider === "custom" ||
      settings.model.provider === "openrouter");

  const update = (patch: Partial<SettingsType["model"]>): void => {
    setSettings({ ...settings, model: { ...settings.model, ...patch } });
  };

  const switchProvider = (provider: SettingsType["model"]["provider"]): void => {
    const p = PROVIDER_PRESETS[provider];
    setSettings({
      ...settings,
      model: {
        ...settings.model,
        provider,
        model: p.defaultModel || settings.model.model,
        baseUrl: p.baseUrl,
      },
    });
    setVerifyResult(null);
    void window.deepwork.settings.getKey(provider).then(setApiKey);
  };

  const addMcp = (): void => {
    const id = `mcp-${Date.now()}`;
    const srv: McpServerConfig = {
      id,
      label: "New MCP server",
      transport: "stdio",
      command: "",
      args: [],
      enabled: true,
    };
    setSettings({ ...settings, mcpServers: [...settings.mcpServers, srv] });
  };

  const updateMcp = (id: string, patch: Partial<McpServerConfig>): void => {
    setSettings({
      ...settings,
      mcpServers: settings.mcpServers.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    });
  };

  const removeMcp = (id: string): void => {
    setSettings({ ...settings, mcpServers: settings.mcpServers.filter((m) => m.id !== id) });
  };

  const verify = async (): Promise<void> => {
    setVerifying(true);
    setVerifyResult(null);
    if (needsKey) await window.deepwork.settings.setKey(settings.model.provider, apiKey.trim());
    const r = await window.deepwork.models.verify(settings.model);
    setVerifyResult(r);
    setVerifying(false);
  };

  const save = async (): Promise<void> => {
    await window.deepwork.settings.save(settings);
    if (needsKey) await window.deepwork.settings.setKey(settings.model.provider, apiKey.trim());
    await window.deepwork.settings.rebuildAgent();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const addMemory = async (): Promise<void> => {
    const text = newMemory.trim();
    if (!text) return;
    const m = await window.deepwork.memories.add(text);
    setMemories((prev) => [...prev, m]);
    setNewMemory("");
  };

  const removeMemory = async (id: string): Promise<void> => {
    await window.deepwork.memories.remove(id);
    setMemories((prev) => prev.filter((m) => m.id !== id));
  };

  return (
    <div className="settings">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Settings</h2>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>

      <h3>Model</h3>
      <div className="field">
        <label>Provider</label>
        <select
          value={settings.model.provider}
          onChange={(e) =>
            switchProvider(e.target.value as SettingsType["model"]["provider"])
          }
        >
          {Object.values(PROVIDER_PRESETS).map((p) => (
            <option key={p.kind} value={p.kind}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Model ID</label>
        {models.length > 0 && (
          <select
            value={models.some((m) => m.id === settings.model.model) ? settings.model.model : ""}
            onChange={(e) => update({ model: e.target.value })}
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
          onChange={(e) => update({ model: e.target.value })}
          placeholder={preset.defaultModel}
        />
      </div>
      {settings.model.provider === "ollama" ? (
        <div className="field">
          <label>Ollama URL</label>
          <input
            value={settings.model.baseUrl ?? ""}
            onChange={(e) => update({ baseUrl: e.target.value })}
            placeholder={preset.baseUrl}
          />
        </div>
      ) : needsBaseUrl ? (
        <div className="field">
          <label>Base URL</label>
          <input
            value={settings.model.baseUrl ?? ""}
            onChange={(e) => update({ baseUrl: e.target.value })}
            placeholder={preset.baseUrl}
          />
        </div>
      ) : null}

      <h3>API keys</h3>
      {needsKey && (
        <div className="field">
          <label>
            {preset.label} API key
            {preset.envKey ? ` (or set ${preset.envKey})` : ""}
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={preset.keyPlaceholder}
          />
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
        <button className="btn" onClick={verify} disabled={verifying}>
          {verifying ? "Verifying…" : "Test connection"}
        </button>
        {verifyResult && (
          <span style={{ color: verifyResult.ok ? "var(--ok)" : "var(--danger)", fontSize: 13 }}>
            {verifyResult.ok ? "✓ " : "✕ "}
            {verifyResult.message}
          </span>
        )}
      </div>

      <h3>Workspace</h3>
      <div className="field">
        <label>Directory the agent can read &amp; write</label>
        <div className="row">
          <input
            value={settings.model.workspaceDir}
            onChange={(e) => update({ workspaceDir: e.target.value })}
            placeholder="defaults to your home directory"
          />
          <button
            className="btn"
            onClick={async () => {
              const dir = await window.deepwork.settings.pickDirectory();
              if (dir) update({ workspaceDir: dir });
            }}
          >
            Browse
          </button>
        </div>
      </div>

      <h3>Long-term memory</h3>
      <p style={{ color: "var(--text-dim)", fontSize: 13, marginTop: -4 }}>
        Facts the agent remembers across all sessions.
      </p>
      <div className="memory-list">
        {memories.map((m) => (
          <div key={m.id} className="memory-item">
            <span>{m.content}</span>
            <button className="icon-btn" onClick={() => removeMemory(m.id)} title="Forget">
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <input
          value={newMemory}
          onChange={(e) => setNewMemory(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void addMemory();
          }}
          placeholder="e.g. The user prefers concise answers in Chinese."
        />
        <button className="btn" onClick={addMemory}>
          Add
        </button>
      </div>

      <h3>Application</h3>
      <label className="switch-row">
        <input
          type="checkbox"
          checked={settings.trayEnabled}
          onChange={(e) => setSettings({ ...settings, trayEnabled: e.target.checked })}
        />
        Show in menu bar / close to tray
      </label>
      <label className="switch-row">
        <input
          type="checkbox"
          checked={settings.autoUpdate}
          onChange={(e) => setSettings({ ...settings, autoUpdate: e.target.checked })}
        />
        Automatically download updates
      </label>

      <h3>MCP plugins</h3>
      {settings.mcpServers.map((m) => (
        <div key={m.id} className="mcp-card">
          <div className="field">
            <label>Label</label>
            <input value={m.label} onChange={(e) => updateMcp(m.id, { label: e.target.value })} />
          </div>
          <div className="field">
            <label>Transport</label>
            <select
              value={m.transport}
              onChange={(e) =>
                updateMcp(m.id, { transport: e.target.value as McpServerConfig["transport"] })
              }
            >
              <option value="stdio">stdio</option>
              <option value="sse">SSE / HTTP</option>
            </select>
          </div>
          {m.transport === "stdio" ? (
            <>
              <div className="field">
                <label>Command</label>
                <input
                  value={m.command ?? ""}
                  onChange={(e) => updateMcp(m.id, { command: e.target.value })}
                  placeholder="npx"
                />
              </div>
              <div className="field">
                <label>Args (space separated)</label>
                <input
                  value={(m.args ?? []).join(" ")}
                  onChange={(e) =>
                    updateMcp(m.id, { args: e.target.value.split(" ").filter(Boolean) })
                  }
                  placeholder="-y @modelcontextprotocol/server-filesystem /"
                />
              </div>
            </>
          ) : (
            <div className="field">
              <label>URL</label>
              <input
                value={m.url ?? ""}
                onChange={(e) => updateMcp(m.id, { url: e.target.value })}
                placeholder="http://localhost:3000/sse"
              />
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label>
              <input
                type="checkbox"
                checked={m.enabled}
                onChange={(e) => updateMcp(m.id, { enabled: e.target.checked })}
              />{" "}
              Enabled
            </label>
            <button className="btn danger" onClick={() => removeMcp(m.id)}>
              Remove
            </button>
          </div>
        </div>
      ))}
      <button className="btn" onClick={addMcp}>
        + Add MCP server
      </button>

      <div style={{ marginTop: 24, display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn primary" onClick={save}>
          Save &amp; apply
        </button>
        {saved && <span style={{ color: "var(--ok)" }}>Saved ✓</span>}
      </div>
    </div>
  );
}
