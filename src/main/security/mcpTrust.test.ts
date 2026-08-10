import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../../shared/types";

const rows = vi.hoisted(() => new Map<string, string>());
vi.mock("../storage/db", () => ({
  getDb: () => ({
    prepare: () => ({
      get: (key: string) => rows.has(key) ? { value: rows.get(key)! } : undefined,
      run: (key: string, value: string) => rows.set(key, value),
    }),
  }),
}));

import {
  loadMcpTrustGrants,
  mcpServerFingerprint,
  nextMcpTrustGrants,
  safeMcpApprovalDetail,
  saveMcpTrustGrants,
  serversRequiringApproval,
} from "./mcpTrust";

function stdio(patch: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "local-tools",
    label: "Local tools",
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    env: { API_TOKEN: "secret-value", MODE: "safe" },
    enabled: true,
    ...patch,
  };
}

describe("MCP configuration trust", () => {
  beforeEach(() => rows.clear());
  it("fingerprints execution fields deterministically but ignores labels", () => {
    const a = stdio();
    const reordered = stdio({
      label: "Renamed",
      env: { MODE: "safe", API_TOKEN: "secret-value" },
    });
    expect(mcpServerFingerprint(a)).toBe(mcpServerFingerprint(reordered));
  });

  it("invalidates trust when command, args, env, URL, or transport changes", () => {
    const original = stdio();
    const fingerprint = mcpServerFingerprint(original);
    for (const changed of [
      stdio({ command: "python" }),
      stdio({ args: ["other.js"] }),
      stdio({ env: { API_TOKEN: "new-secret", MODE: "safe" } }),
      stdio({ transport: "sse", command: undefined, args: undefined, env: undefined, url: "https://example.com/mcp" }),
    ]) {
      expect(mcpServerFingerprint(changed)).not.toBe(fingerprint);
    }
  });

  it("requires approval for enabled untrusted servers and after re-enable", () => {
    const server = stdio();
    const grant = { [server.id]: mcpServerFingerprint(server) };
    expect(serversRequiringApproval([server], grant)).toEqual([]);
    expect(serversRequiringApproval([stdio({ enabled: false })], {})).toEqual([]);
    expect(serversRequiringApproval([server], {})).toEqual([server]);
  });

  it("retains only enabled unchanged or newly approved grants", () => {
    const trusted = stdio();
    const changed = stdio({ id: "changed", command: "python" });
    const disabled = stdio({ id: "disabled", enabled: false });
    const previous = {
      [trusted.id]: mcpServerFingerprint(trusted),
      [changed.id]: mcpServerFingerprint(stdio({ id: "changed" })),
      [disabled.id]: mcpServerFingerprint(disabled),
    };
    expect(nextMcpTrustGrants(
      [trusted, changed, disabled],
      new Set([changed.id]),
      previous,
    )).toEqual({
      [trusted.id]: mcpServerFingerprint(trusted),
      [changed.id]: mcpServerFingerprint(changed),
    });
  });

  it("never exposes environment values in approval details", () => {
    const detail = safeMcpApprovalDetail(stdio());
    expect(detail).toContain("API_TOKEN");
    expect(detail).toContain("MODE");
    expect(detail).not.toContain("secret-value");
    expect(detail).not.toContain("safe");
  });

  it("persists only fingerprints and fails closed on corrupt grant data", () => {
    const server = stdio();
    saveMcpTrustGrants([server], new Set([server.id]), {});
    expect(loadMcpTrustGrants()).toEqual({
      [server.id]: mcpServerFingerprint(server),
    });
    expect([...rows.values()].join(" ")).not.toContain("secret-value");

    rows.set("mcp_trust_grants_v1", "not-json");
    expect(loadMcpTrustGrants()).toEqual({});
  });
});
