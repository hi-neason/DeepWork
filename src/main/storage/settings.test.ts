import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("better-sqlite3", () => import("../../test/mocks/better-sqlite3"));
vi.mock("electron", () => import("../../test/mocks/electron"));
vi.mock("../config/paths", () => ({
  APP_DATA_DIR: "/tmp",
  DEFAULT_WORKSPACE_DIR: "/tmp/deepwork/workspace",
}));
vi.mock("./memories", () => ({ listAllMemories: vi.fn(() => []) }));
vi.mock("../log/logger", () => ({
  configureLogger: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { safeStorage } from "../../test/mocks/electron";
import { getDb } from "./db";
import { getApiKey, loadSettings, saveSettings, setApiKey } from "./settings";
import { configureLogger } from "../log/logger";

describe("settings storage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(safeStorage, "isEncryptionAvailable").mockReturnValue(true);
    vi.spyOn(safeStorage, "encryptString").mockImplementation((value) =>
      Buffer.from(`encrypted:${value}`, "utf8"),
    );
    vi.spyOn(safeStorage, "decryptString").mockImplementation((value) =>
      value.toString("utf8").replace(/^encrypted:/, ""),
    );
    getDb().prepare("DELETE FROM settings").run();
  });

  it("encrypts, overwrites, reads, and explicitly deletes provider keys", () => {
    setApiKey("openai", "first-secret");
    let row = getDb().prepare("SELECT value FROM settings WHERE key = ?")
      .get("secret:api_key:openai") as { value: string };
    expect(row.value).not.toContain("first-secret");
    expect(JSON.parse(row.value)).toMatchObject({ v: 1 });
    expect(getApiKey("openai")).toBe("first-secret");

    setApiKey("openai", "second-secret");
    expect(getApiKey("openai")).toBe("second-secret");

    setApiKey("openai", "");
    row = getDb().prepare("SELECT value FROM settings WHERE key = ?")
      .get("secret:api_key:openai") as { value: string };
    expect(row).toBeUndefined();
    expect(getApiKey("openai")).toBe("");
  });

  it("refuses non-empty key persistence when OS encryption is unavailable", () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);

    expect(() => setApiKey("openai", "secret")).toThrow(/safeStorage|encryption/i);
    expect(getDb().prepare("SELECT value FROM settings WHERE key = ?")
      .get("secret:api_key:openai")).toBeUndefined();
  });

  it.each([
    ["malformed envelope", "not-json"],
    ["unknown envelope version", JSON.stringify({ v: 2, enc: "AA==" })],
    ["missing ciphertext", JSON.stringify({ v: 1 })],
  ])("returns an empty key for %s", (_name, value) => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("secret:api_key:openai", value);

    expect(getApiKey("openai")).toBe("");
  });

  it("returns an empty key when ciphertext cannot be decrypted", () => {
    setApiKey("openai", "secret");
    vi.mocked(safeStorage.decryptString).mockImplementation(() => {
      throw new Error("keychain identity changed");
    });

    expect(getApiKey("openai")).toBe("");
  });

  it("persists ordinary settings separately and reconfigures logging", () => {
    const settings = loadSettings();
    settings.language = "zh-CN";
    settings.logEnabled = true;
    settings.model.workspaceDir = "";
    saveSettings(settings);

    expect(loadSettings().language).toBe("zh-CN");
    expect(configureLogger).toHaveBeenCalledWith({ enabled: true, workspaceDir: "" });
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?")
      .get("app_settings") as { value: string };
    expect(row.value).not.toContain("secret:api_key");
  });
});
