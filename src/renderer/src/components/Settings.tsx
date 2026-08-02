import { useEffect, useState } from "react";
import type { McpServerConfig, Settings as SettingsType } from "../../../shared/types";

interface Props {
  onClose: () => void;
}

export function Settings({ onClose }: Props): React.ReactElement {
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      const s = await window.deepwork.settings.get();
      setSettings(s);
      setAnthropicKey(await window.deepwork.settings.getKey("anthropic"));
      setOpenaiKey(await window.deepwork.settings.getKey("openai"));
    })();
  }, []);

  if (!settings) return <div className="settings">Loading…</div>;

  const update = (patch: Partial<SettingsType["model"]>): void => {
    setSettings({ ...settings, model: { ...settings.model, ...patch } });
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

  const save = async (): Promise<void> => {
    await window.deepwork.settings.save(settings);
    await window.deepwork.settings.setKey("anthropic", anthropicKey.trim());
    await window.deepwork.settings.setKey("openai", openaiKey.trim());
    await window.deepwork.settings.rebuildAgent();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
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
          onChange={(e) => update({ provider: e.target.value as SettingsType["model"]["provider"] })}
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI (compatible)</option>
          <option value="ollama">Ollama (local)</option>
        </select>
      </div>
      <div className="field">
        <label>Model ID</label>
        <input
          value={settings.model.model}
          onChange={(e) => update({ model: e.target.value })}
          placeholder="claude-sonnet-4-5"
        />
      </div>
      {settings.model.provider !== "ollama" && (
        <div className="field">
          <label>Base URL (optional, for OpenAI-compatible endpoints)</label>
          <input
            value={settings.model.baseUrl ?? ""}
            onChange={(e) => update({ baseUrl: e.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </div>
      )}
      {settings.model.provider === "ollama" && (
        <div className="field">
          <label>Ollama URL</label>
          <input
            value={settings.model.baseUrl ?? ""}
            onChange={(e) => update({ baseUrl: e.target.value })}
            placeholder="http://localhost:11434"
          />
        </div>
      )}

      <h3>API keys</h3>
      {settings.model.provider === "anthropic" && (
        <div className="field">
          <label>Anthropic API key</label>
          <input
            type="password"
            value={anthropicKey}
            onChange={(e) => setAnthropicKey(e.target.value)}
            placeholder="sk-ant-..."
          />
        </div>
      )}
      {settings.model.provider === "openai" && (
        <div className="field">
          <label>OpenAI API key</label>
          <input
            type="password"
            value={openaiKey}
            onChange={(e) => setOpenaiKey(e.target.value)}
            placeholder="sk-..."
          />
        </div>
      )}

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

      <h3>MCP plugins</h3>
      {settings.mcpServers.map((m) => (
        <div
          key={m.id}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 12,
            marginBottom: 10,
          }}
        >
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
