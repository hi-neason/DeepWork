import { createHash } from "node:crypto";
import type { McpServerConfig } from "../../shared/types";
import { getDb } from "../storage/db";

const TRUST_KEY = "mcp_trust_grants_v1";

export type McpTrustGrants = Record<string, string>;

function sortedRecord(input: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Fingerprint only fields that affect what is executed or contacted. */
export function mcpServerFingerprint(server: McpServerConfig): string {
  const executable = server.transport === "stdio"
    ? {
        transport: "stdio",
        command: server.command ?? "",
        args: server.args ?? [],
        env: sortedRecord(server.env),
      }
    : {
        transport: "sse",
        url: server.url?.trim() ?? "",
      };
  return createHash("sha256").update(JSON.stringify(executable)).digest("hex");
}

/** Human-readable native-dialog detail. Never includes environment values. */
export function safeMcpApprovalDetail(server: McpServerConfig): string {
  if (server.transport === "sse") {
    return `ID: ${server.id}\nURL: ${server.url?.trim() ?? ""}`;
  }
  const args = server.args?.length ? JSON.stringify(server.args) : "[]";
  const envNames = Object.keys(server.env ?? {}).sort();
  return [
    `ID: ${server.id}`,
    `Command: ${server.command ?? ""}`,
    `Arguments: ${args}`,
    `Environment variables: ${envNames.length ? envNames.join(", ") : "(none)"}`,
  ].join("\n");
}

export function serversRequiringApproval(
  servers: McpServerConfig[],
  grants: McpTrustGrants,
): McpServerConfig[] {
  return servers.filter(
    (server) => server.enabled && grants[server.id] !== mcpServerFingerprint(server),
  );
}

export function isMcpServerTrusted(
  server: McpServerConfig,
  grants: McpTrustGrants,
): boolean {
  return server.enabled && grants[server.id] === mcpServerFingerprint(server);
}

export function nextMcpTrustGrants(
  servers: McpServerConfig[],
  approvedServerIds: ReadonlySet<string>,
  previous: McpTrustGrants,
): McpTrustGrants {
  const next: McpTrustGrants = {};
  for (const server of servers) {
    if (!server.enabled) continue;
    const fingerprint = mcpServerFingerprint(server);
    if (previous[server.id] === fingerprint || approvedServerIds.has(server.id)) {
      next[server.id] = fingerprint;
    }
  }
  return next;
}

export function loadMcpTrustGrants(): McpTrustGrants {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(TRUST_KEY) as { value: string } | undefined;
  if (!row) return {};
  try {
    const value = JSON.parse(row.value) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const grants: McpTrustGrants = {};
    for (const [id, fingerprint] of Object.entries(value)) {
      if (typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint)) {
        grants[id] = fingerprint;
      }
    }
    return grants;
  } catch {
    return {};
  }
}

/** Replace grants with exactly the enabled configurations approved by the user. */
export function saveMcpTrustGrants(
  servers: McpServerConfig[],
  approvedServerIds: ReadonlySet<string>,
  previous: McpTrustGrants,
): void {
  const next = nextMcpTrustGrants(servers, approvedServerIds, previous);
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(TRUST_KEY, JSON.stringify(next));
}
