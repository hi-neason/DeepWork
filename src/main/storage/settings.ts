import { getDb } from "./db";
import { safeStorage } from "electron";
import type {
  Settings,
  ModelConfig,
  McpServerConfig,
  PermissionMode,
  ProviderKind,
} from "../../shared/types";
import { listAllMemories } from "./memories";
import { configureLogger } from "../log/logger";

const SETTINGS_KEY = "app_settings";
const SECRET_PREFIX = "secret:";

/** In-memory cache for the merged settings blob (minus memories).
 *  Invalidated by saveSettings() (M-Agent③). */
let cachedSettingsBase: Partial<Settings> | null = null;

const DEFAULT_SETTINGS: Settings = {
  model: {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    workspaceDir: "",
  },
  configuredModels: [],
  mcpServers: [],
  permissionMode: "manual",
  alwaysAllowTools: [],
  onboarded: false,
  trayEnabled: true,
  autoUpdate: true,
  openAtLogin: false,
  keepAwake: true,
  theme: "dark",
  language: "zh-CN",
  fontScale: 1,
  telemetry: false,
  showReasoning: true,
  funMode: false,
  logEnabled: false,
  memory: {
    autoExtract: false,
    embedding: {
      provider: "ollama",
      model: "nomic-embed-text",
      baseUrl: "http://localhost:11434",
    },
    topK: 10,
    threshold: 0.45,
  },
  memories: [],
  includeAgentsMd: true,
  includeClaudeMd: true,
};

export function loadSettings(): Settings {
  // Cache the merged settings blob (everything except `memories`, which is
  // hydrated from the durable store on every call). loadSettings() is invoked
  // many times per turn (model selection, permission mode, cwd resolution …);
  // without a cache each call re-runs the DB query + JSON parse (M-Agent③).
  // The cache is invalidated by saveSettings().
  let base: Partial<Settings> | null = cachedSettingsBase;
  if (!base) {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(SETTINGS_KEY) as { value: string } | undefined;
    base = structuredClone(DEFAULT_SETTINGS);
    if (row) {
      try {
        const parsed = JSON.parse(row.value) as Partial<Settings>;
        base = { ...base, ...parsed };
        // Migrate legacy approvalMode -> permissionMode.
        const legacyApproval = (parsed as { approvalMode?: PermissionMode }).approvalMode;
        if (!parsed.permissionMode && legacyApproval) {
          base.permissionMode = legacyApproval;
        }
      } catch {
        // keep defaults
      }
    }
    cachedSettingsBase = base;
  }
  const merged: Settings = { ...(structuredClone(base) as Settings) };
  // Always hydrate global memories from the durable store (single source of truth).
  merged.memories = listAllMemories();
  return merged;
}

export function saveSettings(settings: Settings): void {
  // Memories are persisted separately; don't let a stale blob clobber them.
  const { memories: _mem, ...rest } = settings;
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(SETTINGS_KEY, JSON.stringify(rest));
  // Invalidate the read cache so subsequent loads see the new values.
  cachedSettingsBase = null;
  // Keep the runtime logger config in sync with the saved settings.
  configureLogger({ enabled: settings.logEnabled, workspaceDir: settings.model.workspaceDir });
}

/** Generic encrypted key per provider. */
export function getApiKey(provider: ProviderKind | string): string {
  const k = SECRET_PREFIX + "api_key:" + provider;
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(k) as { value: string } | undefined;
  if (!row) return "";
  try {
    // Current envelope format (H-S1): `{v:1,enc:"<base64-ciphertext>"}`.
    if (row.value.startsWith("{")) {
      const parsed = JSON.parse(row.value) as { v?: number; enc?: string };
      if (parsed.v === 1 && typeof parsed.enc === "string") {
        if (!safeStorage.isEncryptionAvailable()) return "";
        return safeStorage.decryptString(Buffer.from(parsed.enc, "base64"));
      }
    }
    // Legacy: raw ciphertext written before the envelope existed. Decrypt
    // when possible; if encryption is unavailable we cannot distinguish it
    // from plaintext, so refuse to hand it back rather than leak ciphertext.
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(row.value, "base64"));
      } catch {
        // Not valid base64 ciphertext — treat as legacy plaintext (pre-fix).
        return row.value;
      }
    }
    return "";
  } catch {
    return "";
  }
}

export function setApiKey(provider: ProviderKind | string, value: string): void {
  const k = SECRET_PREFIX + "api_key:" + provider;
  if (!value) {
    getDb().prepare("DELETE FROM settings WHERE key = ?").run(k);
    return;
  }
  // H-S1: never persist an API key in plaintext. The OS keychain is the only
  // acceptable at-rest protection; if it isn't available we refuse the write
  // so a missing keyring doesn't silently drop secrets into a SQLite file.
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "OS encryption (safeStorage) is unavailable; API keys cannot be saved securely. " +
        "Set the key via an environment variable instead.",
    );
  }
  const enc = safeStorage.encryptString(value).toString("base64");
  const envelope = JSON.stringify({ v: 1, enc });
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(k, envelope);
}

export function addMcpServer(cfg: McpServerConfig): void {
  const s = loadSettings();
  s.mcpServers = s.mcpServers.filter((m) => m.id !== cfg.id).concat(cfg);
  saveSettings(s);
}

export function removeMcpServer(id: string): void {
  const s = loadSettings();
  s.mcpServers = s.mcpServers.filter((m) => m.id !== id);
  saveSettings(s);
}

export function updateModelConfig(patch: Partial<ModelConfig>): void {
  const s = loadSettings();
  s.model = { ...s.model, ...patch };
  saveSettings(s);
}
