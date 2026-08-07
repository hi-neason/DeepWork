import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { McpServerConfig } from "../../shared/types";
import { annotateRisk } from "../tools/registry";
import { logger } from "../log/logger";

/**
 * Manages MCP client connections for enabled servers. A fresh client + tool set
 * is built whenever the agent is (re)created; MCP tools are all treated as
 * "external" risk (network/third-party) and gated accordingly.
 */
export class McpManager {
  private client: MultiServerMCPClient | null = null;

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
    const enabled = servers.filter((s) => s.enabled);
    logger.info("mcp", "build_start", { servers: enabled.length });
    if (enabled.length === 0) return [];

    const config: Record<string, any> = {};
    let skipped = 0;
    for (const s of enabled) {
      const entry = this.toClientConfig(s);
      if (entry) config[s.id] = entry;
      else {
        skipped++;
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
    try {
      this.client = new MultiServerMCPClient(config);
      try {
        tools = await this.client.getTools();
      } catch (err) {
        logger.error("mcp", "build_failed", {
          error: err instanceof Error ? err.message : err,
        });
        tools = [];
      }
    } catch (err) {
      // Constructor/validation failure (defensive — toClientConfig should
      // already have filtered these out). Never break agent startup.
      logger.error("mcp", "client_construction_failed", {
        error: err instanceof Error ? err.message : err,
      });
      this.client = null;
      tools = [];
    }
    for (const t of tools) {
      annotateRisk(t.name, "external");
    }
    logger.info("mcp", "build_ok", { tools: tools.length, skipped });
    return tools;
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
