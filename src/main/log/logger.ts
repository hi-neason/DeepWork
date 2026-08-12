import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_WORKSPACE_DIR } from "../config/paths";

export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  TRACE: 10,
  DEBUG: 20,
  INFO: 30,
  WARN: 40,
  ERROR: 50,
};

// File logging keeps every level; the console is threshold-gated so noisy
// high-frequency channels (e.g. per-IPC "handled" debug lines) don't flood the
// dev terminal. Override with DEEPWORK_CONSOLE_LOG_LEVEL=DEBUG|TRACE|...
const DEFAULT_CONSOLE_LEVEL: LogLevel = "INFO";
function resolveConsoleLevel(): LogLevel {
  const raw = (process.env.DEEPWORK_CONSOLE_LOG_LEVEL ?? "").trim().toUpperCase();
  return raw in LEVEL_WEIGHT ? (raw as LogLevel) : DEFAULT_CONSOLE_LEVEL;
}
let consoleLevel: LogLevel = resolveConsoleLevel();

let cachedEnabled = false;
let cachedWorkspace = "";
const ensuredDirs = new Set<string>();
let writeChain: Promise<void> = Promise.resolve();
let warnedNoWorkspace = false;

/** Called by settings save / app start to refresh the active log config. */
export function configureLogger(opts: { enabled: boolean; workspaceDir: string }): void {
  cachedEnabled = !!opts.enabled;
  cachedWorkspace = opts.workspaceDir?.trim() || DEFAULT_WORKSPACE_DIR;
  warnedNoWorkspace = false;
}

function isLikelySecret(key: string): boolean {
  return /(key|token|secret|password|passwd|apikey|authorization|auth|cookie)/i.test(key);
}

// Debugging payloads we want to keep mostly intact (system prompt, full model
// response, tool args, reasoning text, etc.) rather than collapsing to 200 chars.
const VERBOSE_KEYS = /(prompt|response|reasoning|message|content|system|args|output|body|text|preview|messages|tool)/i;

function redact(key: string, value: unknown): unknown {
  if (isLikelySecret(key)) return "<redacted>";
  if (typeof value === "string") {
    if (VERBOSE_KEYS.test(key)) {
      // Verbose debugging fields: keep large payloads, only cap extreme sizes.
      if (value.length > 12000) {
        return value.slice(0, 10000) + ` …[truncated +${value.length - 10000} chars]`;
      }
      return value;
    }
    if (value.length > 500) {
      return value.slice(0, 200) + ` …[truncated +${value.length - 200} chars]`;
    }
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
    return path.join(cachedWorkspace, "sessions", sid);
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
 * Write one structured log line (JSONL) to <workspace>/sessions/<session>/deepwork.log.
 * Gated by cachedEnabled (the settings toggle). An empty configured workspace
 * resolves to the built-in default workspace in configureLogger().
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
  try {
    if (LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[consoleLevel]) {
      const cons = (console as unknown as Record<string, (...a: unknown[]) => void>)[
        level.toLowerCase()
      ] ?? console.log;
      cons(`[${scope}]`, message, meta ?? "");
    }
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
