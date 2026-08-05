import { useTranslation } from "react-i18next";
import type { McpServerConfig, Settings as SettingsType } from "../../../shared/types";

interface Props {
  settings: SettingsType;
  onChange: (patch: Partial<SettingsType>) => void;
}

export function Connectors({ settings, onChange }: Props): React.ReactElement {
  const { t } = useTranslation();

  const updateMcp = (id: string, patch: Partial<McpServerConfig>): void => {
    onChange({
      mcpServers: settings.mcpServers.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    });
  };
  const addMcp = (): void => {
    const srv: McpServerConfig = {
      id: `mcp-${Date.now()}`,
      label: "New MCP server",
      transport: "stdio",
      command: "",
      args: [],
      enabled: true,
    };
    onChange({ mcpServers: [...settings.mcpServers, srv] });
  };
  const removeMcp = (id: string): void => {
    onChange({ mcpServers: settings.mcpServers.filter((m) => m.id !== id) });
  };

  return (
    <div className="settings-section connectors-section">
      <h2>{t("connectors.title")}</h2>
      <p className="section-desc">{t("connectors.mcpHint")}</p>

      {settings.mcpServers.map((m) => (
        <div key={m.id} className="mcp-card">
          <div className="field">
            <label>{t("connectors.label")}</label>
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
                <label>{t("connectors.command")}</label>
                <input
                  value={m.command ?? ""}
                  onChange={(e) => updateMcp(m.id, { command: e.target.value })}
                  placeholder="npx"
                />
              </div>
              <div className="field">
                <label>{t("connectors.args")}</label>
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
              <label>{t("connectors.url")}</label>
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
              {t("connectors.enabled")}
            </label>
            <button className="btn danger" onClick={() => removeMcp(m.id)}>
              {t("connectors.remove")}
            </button>
          </div>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn" onClick={addMcp}>
          {t("connectors.addMcp")}
        </button>
        <span className="auto-save-hint">{t("connectors.autoSaveHint")}</span>
      </div>
    </div>
  );
}
