import { getDb } from "./db";
import { safeStorage } from "electron";
import type {
  Settings,
  ModelConfig,
  McpServerConfig,
  ProviderKind,
} from "../../shared/types";
import { listAllMemories } from "./memories";
import { configureLogger } from "../log/logger";

const SETTINGS_KEY = "app_settings";
const SECRET_PREFIX = "secret:";

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
  memories: [],
};

export function loadSettings(): Settings {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(SETTINGS_KEY) as { value: string } | undefined;
  let merged: Settings = structuredClone(DEFAULT_SETTINGS);
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as Partial<Settings>;
      merged = { ...merged, ...parsed };
      // Migrate legacy approvalMode -> permissionMode.
      if (!parsed.permissionMode && parsed.approvalMode) {
        merged.permissionMode = parsed.approvalMode;
      }
    } catch {
      // keep defaults
    }
  }
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
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(row.value, "base64"));
    }
    return row.value;
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
