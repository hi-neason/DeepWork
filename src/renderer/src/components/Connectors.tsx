import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { McpServerConfig, Settings as SettingsType } from "../../../shared/types";

interface Props {
  settings: SettingsType;
  onChange: (patch: Partial<SettingsType>) => void;
}

export function Connectors({ settings, onChange }: Props): React.ReactElement {
  const { t } = useTranslation();
  const servers = settings.mcpServers ?? [];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importMsg, setImportMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const updateMcp = (id: string, patch: Partial<McpServerConfig>): void => {
    onChange({
      mcpServers: servers.map((m) => (m.id === id ? { ...m, ...patch } : m)),
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
    onChange({ mcpServers: [...servers, srv] });
    setEditingId(srv.id);
  };

  const removeMcp = (id: string): void => {
    onChange({ mcpServers: servers.filter((m) => m.id !== id) });
    if (editingId === id) setEditingId(null);
  };

  const subtitle = (m: McpServerConfig): string => {
    if (m.transport === "sse") return m.url ?? "";
    return [m.command, ...(m.args ?? [])].filter(Boolean).join(" ");
  };

  // Parse a standard mcpServers JSON object and append the servers.
  const doImport = (): void => {
    setImportMsg(null);
    try {
      const parsed = JSON.parse(importText);
      const obj = parsed?.mcpServers ?? parsed;
      if (typeof obj !== "object" || obj === null) throw new Error("missing mcpServers");
      const entries = Object.entries(obj) as Array<[string, Record<string, unknown>]>;
      if (entries.length === 0) throw new Error("no servers in payload");
      const imported: McpServerConfig[] = entries.map(([name, cfg]) => {
        const c = cfg as Record<string, unknown>;
        const isSse = typeof c.url === "string" && c.url !== "" ? true : c.transport === "sse";
        return {
          id: `mcp-${Date.now()}-${name}`,
          label: name,
          transport: isSse ? "sse" : "stdio",
          command: isSse ? undefined : ((c.command as string) ?? ""),
          args: isSse
            ? undefined
            : Array.isArray(c.args)
              ? (c.args as unknown[]).map(String)
              : [],
          url: isSse ? (((c.url as string) ?? "") as string) : undefined,
          enabled: true,
        };
      });
      onChange({ mcpServers: [...servers, ...imported] });
      setImportMsg({ kind: "ok", text: t("connectors.importSuccess", { count: imported.length }) });
      setImportText("");
    } catch (err) {
      setImportMsg({
        kind: "err",
        text: t("connectors.importError", { message: err instanceof Error ? err.message : String(err) }),
      });
    }
  };

  return (
    <div className="settings-section connectors-section">
      <h2>{t("connectors.title")}</h2>
      <p className="section-desc">{t("connectors.mcpHint")}</p>

      <div className="mcp-list">
        {servers.length === 0 && <p className="artifacts-empty">{t("connectors.empty")}</p>}

        {servers.map((m) => {
          const expanded = editingId === m.id;
          return (
            <div key={m.id} className={`mcp-item ${expanded ? "expanded" : ""}`}>
              <div className="mcp-row">
                <button
                  type="button"
                  className={`switch small ${m.enabled ? "on" : ""}`}
                  role="switch"
                  aria-checked={m.enabled}
                  title={t("connectors.enabled")}
                  onClick={() => updateMcp(m.id, { enabled: !m.enabled })}
                >
                  <span className="knob" />
                </button>

                <div className="mcp-main" onClick={() => setEditingId(expanded ? null : m.id)}>
                  <div className="mcp-name">{m.label || t("connectors.untitled")}</div>
                  <div className="mcp-sub">{subtitle(m) || t("connectors.notConfigured")}</div>
                </div>

                <div className="mcp-actions">
                  <button
                    type="button"
                    className={`icon-btn ${expanded ? "active" : ""}`}
                    title={t("common.edit")}
                    onClick={() => setEditingId(expanded ? null : m.id)}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={t("common.delete")}
                    onClick={() => {
                      if (confirm(t("connectors.confirmDelete", { label: m.label || t("connectors.untitled") })))
                        removeMcp(m.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>

              {expanded && (
                <div className="mcp-edit">
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
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mcp-footer">
        <button type="button" className="btn primary" onClick={addMcp}>
          {t("connectors.addMcp")}
        </button>
        <button type="button" className="btn" onClick={() => setShowImport((s) => !s)}>
          {t("connectors.importTitle")}
        </button>
      </div>

      {showImport && (
        <div className="mcp-import">
          <p className="section-desc">{t("connectors.importDesc")}</p>
          <textarea
            className="mcp-import-text"
            rows={8}
            value={importText}
            placeholder={t("connectors.importPlaceholder")}
            onChange={(e) => setImportText(e.target.value)}
          />
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            <button
              type="button"
              className="btn primary"
              onClick={doImport}
              disabled={!importText.trim()}
            >
              {t("connectors.importBtn")}
            </button>
            {importMsg && (
              <span
                className={importMsg.kind === "ok" ? "auto-save-hint" : "field-error"}
                style={importMsg.kind === "ok" ? { color: "var(--ok)" } : undefined}
              >
                {importMsg.text}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
