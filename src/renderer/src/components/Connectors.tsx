import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { McpServerConfig, Settings as SettingsType } from "../../../shared/types";

interface Props {
  settings: SettingsType;
  onChange: (patch: Partial<SettingsType>) => void;
}

/** Serialize a single McpServerConfig to the standard { name: { ... } } shape
 *  (no `transport` field — it's inferred from the presence of `url` vs `command`). */
function serializeServer(m: McpServerConfig): string {
  const config: Record<string, unknown> = { enabled: m.enabled };
  if (m.transport === "sse") {
    if (m.url) config.url = m.url;
  } else {
    if (m.command) config.command = m.command;
    if (m.args && m.args.length > 0) config.args = m.args;
  }
  const name = m.label || "server";
  return JSON.stringify({ [name]: config }, null, 2);
}

interface ParsedServer {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
}

/** Parse a { name: { ... } } JSON object. Throws on malformed input. */
function parseServerJson(text: string): ParsedServer {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty");
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected an object with one server key");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) throw new Error("empty object");
  const [name, rawCfg] = entries[0];
  if (typeof rawCfg !== "object" || rawCfg === null || Array.isArray(rawCfg)) {
    throw new Error("server value must be an object");
  }
  const cfg = rawCfg as Record<string, unknown>;
  const enabled = typeof cfg.enabled === "boolean" ? cfg.enabled : true;
  const command = typeof cfg.command === "string" ? cfg.command : undefined;
  const url = typeof cfg.url === "string" ? cfg.url : undefined;
  const args = Array.isArray(cfg.args)
    ? (cfg.args as unknown[]).map((a) => String(a))
    : undefined;
  if (!command && !url) {
    throw new Error("config must include either `command` (stdio) or `url` (sse)");
  }
  return { name, command, args, url, enabled };
}

export function Connectors({ settings, onChange }: Props): React.ReactElement {
  const { t } = useTranslation();
  const servers = settings.mcpServers ?? [];

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const lastAppliedRef = useRef<string>("");
  const editTextRef = useRef<string>("");
  editTextRef.current = editText;

  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importMsg, setImportMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const updateMcp = (id: string, patch: Partial<McpServerConfig>): void => {
    onChange({
      mcpServers: servers.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    });
  };

  const startEdit = (id: string): void => {
    const m = servers.find((x) => x.id === id);
    if (!m) return;
    const text = serializeServer(m);
    lastAppliedRef.current = text;
    setEditText(text);
    setEditError(null);
    setEditingId(id);
  };

  const closeEdit = (): void => {
    setEditingId(null);
    setEditError(null);
  };

  const addMcp = (): void => {
    const srv: McpServerConfig = {
      id: `mcp-${Date.now()}`,
      label: "my-server",
      transport: "stdio",
      command: "",
      args: [],
      enabled: true,
    };
    onChange({ mcpServers: [...servers, srv] });
    startEdit(srv.id);
  };

  const removeMcp = (id: string): void => {
    onChange({ mcpServers: servers.filter((m) => m.id !== id) });
    if (editingId === id) closeEdit();
  };

  // Parse + apply on every edit. If valid, push the patch up to settings so it
  // auto-saves; if invalid, just show an error and leave the config untouched.
  useEffect(() => {
    if (!editingId) return;
    if (editText === lastAppliedRef.current) return;
    try {
      const parsed = parseServerJson(editText);
      const transport: McpServerConfig["transport"] = parsed.url ? "sse" : "stdio";
      const patch: Partial<McpServerConfig> = {
        label: parsed.name,
        transport,
        enabled: parsed.enabled,
        command: transport === "stdio" ? (parsed.command ?? "") : undefined,
        args: transport === "stdio" ? (parsed.args ?? []) : undefined,
        url: transport === "sse" ? parsed.url : undefined,
      };
      onChange({
        mcpServers: servers.map((m) => (m.id === editingId ? { ...m, ...patch } : m)),
      });
      lastAppliedRef.current = editText;
      setEditError(null);
    } catch (err) {
      setEditError(
        t("connectors.jsonParseError", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    // We intentionally omit `servers` from deps to avoid loops; the parent
    // re-renders, but `editText` is the only user-driven input here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editText, editingId, t]);

  const subtitle = (m: McpServerConfig): string => {
    if (m.transport === "sse") return m.url ?? "";
    return [m.command, ...(m.args ?? [])].filter(Boolean).join(" ");
  };

  // Bulk import: parse a full { mcpServers: { ... } } payload.
  const doImport = (): void => {
    setImportMsg(null);
    try {
      const parsed = JSON.parse(importText);
      const obj = parsed?.mcpServers ?? parsed;
      if (typeof obj !== "object" || obj === null) throw new Error("missing mcpServers");
      const entries = Object.entries(obj) as Array<[string, Record<string, unknown>]>;
      if (entries.length === 0) throw new Error("no servers in payload");
      const imported: McpServerConfig[] = entries.map(([name, cfg]) => {
        const isSse = typeof cfg.url === "string" && cfg.url !== "" ? true : cfg.transport === "sse";
        return {
          id: `mcp-${Date.now()}-${name}`,
          label: name,
          transport: isSse ? "sse" : "stdio",
          command: isSse ? undefined : ((cfg.command as string) ?? ""),
          args: isSse
            ? undefined
            : Array.isArray(cfg.args)
              ? (cfg.args as unknown[]).map(String)
              : [],
          url: isSse ? (((cfg.url as string) ?? "") as string) : undefined,
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

                <div className="mcp-main" onClick={() => (expanded ? closeEdit() : startEdit(m.id))}>
                  <div className="mcp-name">{m.label || t("connectors.untitled")}</div>
                  <div className="mcp-sub">{subtitle(m) || t("connectors.notConfigured")}</div>
                </div>

                <div className="mcp-actions">
                  <button
                    type="button"
                    className={`icon-btn ${expanded ? "active" : ""}`}
                    title={t("common.edit")}
                    onClick={() => (expanded ? closeEdit() : startEdit(m.id))}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={t("common.delete")}
                    onClick={() => {
                      if (
                        confirm(
                          t("connectors.confirmDelete", {
                            label: m.label || t("connectors.untitled"),
                          }),
                        )
                      )
                        removeMcp(m.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>

              {expanded && (
                <div className="mcp-edit">
                  <div className="mcp-edit-head">
                    <span className="mcp-edit-title">{t("connectors.jsonEditor")}</span>
                    {!editError && (
                      <span className="auto-save-hint" style={{ color: "var(--ok)" }}>
                        ✓
                      </span>
                    )}
                  </div>
                  <p className="mcp-edit-hint">{t("connectors.jsonHint")}</p>
                  <textarea
                    className="mcp-json-text"
                    rows={10}
                    spellCheck={false}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                  />
                  {editError && <div className="field-error">{editError}</div>}
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