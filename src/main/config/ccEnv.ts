import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Reuse Claude Code's environment configuration without copying any secret into
 * DeepWork's code or settings. At startup we read the `env` block from Claude
 * Code's settings files and merge it into process.env. Variables already set in
 * the shell take precedence (so a user can override).
 *
 * Files read (later wins):
 *   ~/.claude/settings.json
 *   ~/.claude/settings.local.json
 *
 * No values are logged or persisted by DeepWork.
 */
export function loadClaudeCodeEnv(): void {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".claude", "settings.json"),
    path.join(home, ".claude", "settings.local.json"),
  ];

  for (const file of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const env = (parsed as { env?: Record<string, string> } | null)?.env;
    if (!env || typeof env !== "object") continue;

    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== "string") continue;
      // Shell/already-set variables win; CC settings fill in the rest.
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }

  // Some Anthropic-compatible gateways (e.g. Volcengine Ark) need the SDK to
  // send the token as a bearer; ANTHROPIC_AUTH_TOKEN is already honored by the
  // SDK directly, no extra wiring needed.
  void app; // app may be used later for logging/surfacing config status
}
