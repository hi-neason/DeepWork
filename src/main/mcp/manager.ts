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

  async buildTools(servers: McpServerConfig[]): Promise<StructuredToolInterface[]> {
    await this.close();
    const enabled = servers.filter((s) => s.enabled);
    logger.info("mcp", "build_start", { servers: enabled.length });
    if (enabled.length === 0) return [];

    const config: Record<string, any> = {};
    for (const s of enabled) {
      if (s.transport === "stdio") {
        config[s.id] = {
          transport: "stdio",
          command: s.command,
          args: s.args ?? [],
          env: s.env ?? {},
        };
      } else {
        config[s.id] = { transport: "sse", url: s.url };
      }
    }

    this.client = new MultiServerMCPClient(config);
    let tools: StructuredToolInterface[];
    try {
      tools = await this.client.getTools();
    } catch (err) {
      logger.error("mcp", "build_failed", { error: err instanceof Error ? err.message : err });
      tools = [];
    }
    for (const t of tools) {
      annotateRisk(t.name, "external");
    }
    logger.info("mcp", "build_ok", { tools: tools.length });
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
