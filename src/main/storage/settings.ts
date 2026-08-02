import { getDb } from "./db";
import { safeStorage } from "electron";
import type { Settings, ModelConfig, McpServerConfig } from "../../shared/types";

const SETTINGS_KEY = "app_settings";
const SECRET_PREFIX = "secret:";
// API keys are stored separately and encrypted at rest with safeStorage.
const KEYS = {
  anthropic: "anthropic_api_key",
  openai: "openai_api_key",
  ollama: "",
} as const;

const DEFAULT_SETTINGS: Settings = {
  model: {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    workspaceDir: "",
  },
  mcpServers: [],
  alwaysAllowTools: [],
};

export function loadSettings(): Settings {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(SETTINGS_KEY) as { value: string } | undefined;
  if (!row) return structuredClone(DEFAULT_SETTINGS);
  try {
    const parsed = JSON.parse(row.value) as Settings;
    return { ...structuredClone(DEFAULT_SETTINGS), ...parsed };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(settings: Settings): void {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(SETTINGS_KEY, JSON.stringify(settings));
}

export function getApiKey(provider: keyof typeof KEYS): string {
  const storageKey = KEYS[provider];
  if (!storageKey) return "";
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(SECRET_PREFIX + storageKey) as { value: string } | undefined;
  if (!row) return "";
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(row.value, "base64"));
    }
    return row.value;
  } catch {
    return "";
  }
}

export function setApiKey(provider: keyof typeof KEYS, value: string): void {
  const storageKey = KEYS[provider];
  if (!storageKey) return;
  const k = SECRET_PREFIX + storageKey;
  if (!value) {
    getDb().prepare("DELETE FROM settings WHERE key = ?").run(k);
    return;
  }
  const stored = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(value).toString("base64")
    : value;
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(k, stored);
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
