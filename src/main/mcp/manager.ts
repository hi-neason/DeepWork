import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { McpServerConfig } from "../../shared/types";
import { annotateRisk } from "../tools/registry";

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
      console.error("[mcp] failed to load tools", err);
      tools = [];
    }
    for (const t of tools) {
      annotateRisk(t.name, "external");
    }
    return tools;
  }

  async close(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.close();
    } catch (err) {
      console.error("[mcp] close error", err);
    } finally {
      this.client = null;
    }
  }
}
