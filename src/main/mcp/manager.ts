import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { McpServerConfig, McpServerStatus } from "../../shared/types";
import { annotateRisk, isReservedToolName } from "../tools/registry";
import { logger } from "../log/logger";
import { isMcpServerTrusted, loadMcpTrustGrants } from "../security/mcpTrust";
import i18n from "../i18n";

export type { McpServerStatus };

export const MCP_TOOLS_TIMEOUT_MS = 30_000;

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Manages MCP client connections for enabled servers. A fresh client + tool set
 * is built whenever the agent is (re)created; MCP tools are all treated as
 * "external" risk (network/third-party) and gated accordingly.
 */
export class McpManager {
  private client: MultiServerMCPClient | null = null;
  /** Outcome of the most recent buildTools run, keyed by server id. */
  private lastStatus = new Map<string, McpServerStatus>();

  constructor(private readonly toolsTimeoutMs = MCP_TOOLS_TIMEOUT_MS) {}

  /** Per-server outcomes from the last build (for the Connectors UI). */
  getLastStatus(): McpServerStatus[] {
    return Array.from(this.lastStatus.values());
  }

  /** Reset recorded status (e.g. when servers are disabled/removed). */
  clearStatus(): void {
    this.lastStatus.clear();
  }

  /**
   * Build a single server's client config, or null if it is incomplete/invalid
   * (e.g. stdio missing a command, or sse/http missing a valid URL). Invalid
   * servers are skipped rather than throwing, so one bad entry never blocks the
   * whole agent build or chat-history load.
   */
  private toClientConfig(s: McpServerConfig): Record<string, unknown> | null {
    if (s.transport === "stdio") {
      if (!s.command || !s.command.trim()) return null;
      return {
        transport: "stdio",
        command: s.command,
        args: Array.isArray(s.args) ? s.args.map(String) : [],
        env: Object.fromEntries(
          Object.entries(s.env ?? {}).map(([k, v]) => [k, String(v)]),
        ),
      };
    }
    // sse / http
    if (!s.url || !/^https?:\/\//i.test(s.url.trim())) return null;
    return { transport: "sse", url: s.url.trim() };
  }

  async buildTools(servers: McpServerConfig[]): Promise<StructuredToolInterface[]> {
    await this.close();
    this.lastStatus = new Map();
    const configuredEnabled = servers.filter((s) => s.enabled);
    const grants = loadMcpTrustGrants();
    const enabled: McpServerConfig[] = [];
    for (const server of configuredEnabled) {
      if (isMcpServerTrusted(server, grants)) {
        enabled.push(server);
      } else {
        this.lastStatus.set(server.id, {
          id: server.id,
          label: server.label || server.id,
          ok: false,
          error: i18n.t("mcpTrust.required"),
        });
        logger.warn("mcp", "server_untrusted", {
          id: server.id,
          label: server.label,
          transport: server.transport,
        });
      }
    }
    logger.info("mcp", "build_start", { servers: enabled.length });
    if (enabled.length === 0) return [];

    const config: Record<string, any> = {};
    let skipped = 0;
    for (const s of enabled) {
      const entry = this.toClientConfig(s);
      if (entry) {
        config[s.id] = entry;
      } else {
        skipped++;
        const reason =
          s.transport === "stdio"
            ? "Missing command (stdio server has no executable configured)"
            : "Missing or invalid URL (must start with http:// or https://)";
        this.lastStatus.set(s.id, {
          id: s.id,
          label: s.label || s.id,
          ok: false,
          error: reason,
        });
        logger.warn("mcp", "server_skipped", {
          id: s.id,
          label: s.label,
          transport: s.transport,
        });
      }
    }
    if (Object.keys(config).length === 0) {
      logger.warn("mcp", "all_servers_skipped", { enabled: enabled.length });
      return [];
    }

    let tools: StructuredToolInterface[] = [];
    let buildError: string | undefined;
    try {
      this.client = new MultiServerMCPClient(config);
      try {
        tools = await withTimeout(this.client.getTools(), this.toolsTimeoutMs, "MCP tool discovery");
      } catch (err) {
        buildError = err instanceof Error ? err.message : String(err);
        logger.error("mcp", "build_failed", { error: buildError });
        await this.close();
        tools = [];
      }
    } catch (err) {
      // Constructor/validation failure (defensive — toClientConfig should
      // already have filtered these out). Never break agent startup.
      buildError = err instanceof Error ? err.message : String(err);
      logger.error("mcp", "client_construction_failed", { error: buildError });
      this.client = null;
      tools = [];
    }

    // Attribute outcomes per server. The LangChain adapter throws a single
    // aggregated error rather than per-server rejections, so a build failure is
    // reported against every server that actually made it into the config;
    // successful servers are marked ok (M-storage⑤).
    for (const s of enabled) {
      if (this.lastStatus.has(s.id)) continue; // already marked skipped
      this.lastStatus.set(s.id, {
        id: s.id,
        label: s.label || s.id,
        ok: !buildError,
        ...(buildError ? { error: buildError } : {}),
      });
    }

    // C-T4: an MCP server must not be able to publish a tool that shadows a
    // built-in (`execute`, `write_file`, …). Doing so would both hijack the
    // call and inherit the built-in's lower risk annotation. Drop the
    // conflicting tool instead of trusting it.
    const safeTools: StructuredToolInterface[] = [];
    let hijacked = 0;
    for (const t of tools) {
      if (isReservedToolName(t.name)) {
        hijacked++;
        logger.warn("mcp", "tool_name_conflict", { tool: t.name });
        continue;
      }
      annotateRisk(t.name, "external");
      safeTools.push(t);
    }
    logger.info("mcp", "build_ok", {
      tools: safeTools.length,
      skipped,
      ...(hijacked ? { rejected: hijacked } : {}),
    });
    return safeTools;
  }

  async close(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.close();
    } catch (err) {
      logger.error("mcp", "close_error", { error: err instanceof Error ? err.message : err });
    } finally {
      this.client = null;
    }
  }
}
