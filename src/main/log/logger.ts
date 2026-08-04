import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR";

let cachedEnabled = false;
let cachedWorkspace = "";
const ensuredDirs = new Set<string>();
let writeChain: Promise<void> = Promise.resolve();
let warnedNoWorkspace = false;

/** Called by settings save / app start to refresh the active log config. */
export function configureLogger(opts: { enabled: boolean; workspaceDir: string }): void {
  cachedEnabled = !!opts.enabled;
  cachedWorkspace = opts.workspaceDir?.trim() ?? "";
  if (cachedWorkspace) warnedNoWorkspace = false;
}

function isLikelySecret(key: string): boolean {
  return /(key|token|secret|password|passwd|apikey|authorization|auth|cookie)/i.test(key);
}

function redact(key: string, value: unknown): unknown {
  if (isLikelySecret(key)) return "<redacted>";
  if (typeof value === "string" && value.length > 500) {
    return value.slice(0, 200) + ` …[truncated +${value.length - 200} chars]`;
  }
  return value;
}

function sanitize(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) out[k] = redact(k, v);
  return out;
}

function dirFor(sessionId?: string): string | null {
  if (cachedWorkspace) {
    const sid = sessionId && sessionId.trim() ? sessionId : "global";
    return path.join(cachedWorkspace, "logs", sid);
  }
  return null;
}

function ensure(dir: string): Promise<void> {
  if (ensuredDirs.has(dir)) return Promise.resolve();
  return mkdir(dir, { recursive: true })
    .then(() => {
      ensuredDirs.add(dir);
    })
    .catch((e) => {
      console.error("[logger] mkdir failed", dir, e);
    });
}

/**
 * Write one structured log line (JSONL) to <workspace>/logs/<session>/deepwork.log.
 * Gated by cachedEnabled (the settings toggle). When no workspace is set, only
 * ERROR-level lines fall back to the app-data dir so fatal crashes are never lost;
 * all other levels are suppressed with a one-time console warning.
 */
export function log(
  level: LogLevel,
  scope: string,
  message: string,
  meta?: Record<string, unknown>,
  sessionId?: string,
): void {
  if (!cachedEnabled) return;
  const sid = sessionId && sessionId.trim() ? sessionId : "global";
  const dir = dirFor(sessionId);
  if (!dir) {
    // No default workspace: per settings, logging is disabled (file output
    // would have no meaningful location). Warn once so the omission is visible.
    if (!warnedNoWorkspace) {
      warnedNoWorkspace = true;
      console.warn(
        "[logger] log output disabled: no default workspace set. Set a default workspace in Settings > General to enable local logs.",
      );
    }
    return;
  }
  const entry = {
    ts: new Date().toISOString(),
    level,
    scope,
    session: sid,
    msg: message,
    ...(sanitize(meta) ?? {}),
  };
  const line = JSON.stringify(entry) + "\n";
  const cons = (console as unknown as Record<string, (...a: unknown[]) => void>)[
    level.toLowerCase()
  ] ?? console.log;
  try {
    cons(`[${scope}]`, message, meta ?? "");
  } catch {
    /* ignore */
  }
  writeChain = writeChain
    .then(() => ensure(dir!))
    .then(() => appendFile(path.join(dir!, "deepwork.log"), line))
    .catch((e) => {
      console.error("[logger] write failed", e);
    });
}

export const logger = {
  trace: (s: string, m: string, meta?: Record<string, unknown>, sid?: string) =>
    log("TRACE", s, m, meta, sid),
  debug: (s: string, m: string, meta?: Record<string, unknown>, sid?: string) =>
    log("DEBUG", s, m, meta, sid),
  info: (s: string, m: string, meta?: Record<string, unknown>, sid?: string) =>
    log("INFO", s, m, meta, sid),
  warn: (s: string, m: string, meta?: Record<string, unknown>, sid?: string) =>
    log("WARN", s, m, meta, sid),
  error: (s: string, m: string, meta?: Record<string, unknown>, sid?: string) =>
    log("ERROR", s, m, meta, sid),
};
