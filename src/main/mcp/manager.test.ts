import { afterEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  constructed: vi.fn(),
  getTools: vi.fn(async () => []),
  close: vi.fn(async () => undefined),
}));
vi.mock("@langchain/mcp-adapters", () => ({
  MultiServerMCPClient: class {
    constructor(config: unknown) {
      client.constructed(config);
    }
    getTools = client.getTools;
    close = client.close;
  },
}));

const trust = vi.hoisted(() => ({
  loadMcpTrustGrants: vi.fn(() => ({})),
  isMcpServerTrusted: vi.fn(() => false),
}));
vi.mock("../security/mcpTrust", () => trust);
vi.mock("../log/logger", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { McpManager } from "./manager";

const server = {
  id: "local",
  label: "Local MCP",
  transport: "stdio" as const,
  command: "node",
  args: ["server.js"],
  enabled: true,
};

describe("McpManager trust enforcement", () => {
  afterEach(() => vi.clearAllMocks());

  it("does not construct a client for an enabled but untrusted server", async () => {
    const manager = new McpManager();
    expect(await manager.buildTools([server])).toEqual([]);
    expect(client.constructed).not.toHaveBeenCalled();
    expect(manager.getLastStatus()).toEqual([
      expect.objectContaining({ id: "local", ok: false }),
    ]);
  });

  it("constructs a client only after the exact configuration is trusted", async () => {
    trust.isMcpServerTrusted.mockReturnValueOnce(true);
    const manager = new McpManager();
    await manager.buildTools([server]);
    expect(client.constructed).toHaveBeenCalledWith({
      local: {
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env: {},
      },
    });
  });
});
