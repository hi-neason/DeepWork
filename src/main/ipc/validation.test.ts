import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  automationCreateSchema,
  automationUpdateSchema,
  assertExistingFileWithin,
  chatSendArgsSchema,
  sessionWorkspaceArgsSchema,
  settingsSchema,
  terminalInputArgsSchema,
  terminalResizeArgsSchema,
} from "./validation";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepwork-ipc-validation-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("IPC validation", () => {
  it("accepts a real file contained by the allowed root", () => {
    const root = tempDir();
    const file = path.join(root, "report.txt");
    fs.writeFileSync(file, "ok");

    expect(assertExistingFileWithin(root, file)).toBe(fs.realpathSync(file));
  });

  it("rejects lexical traversal and symlinks escaping the allowed root", () => {
    const root = tempDir();
    const outside = tempDir();
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "secret");
    const link = path.join(root, "report.txt");
    fs.symlinkSync(secret, link);

    expect(() => assertExistingFileWithin(root, secret)).toThrow(/outside/);
    expect(() => assertExistingFileWithin(root, link)).toThrow(/outside/);
  });

  it("rejects directories, relative paths, oversized input, and invalid PTY sizes", () => {
    const root = tempDir();
    expect(() => assertExistingFileWithin(root, root)).toThrow(/not a file/);
    expect(() => assertExistingFileWithin(root, "report.txt")).toThrow(/absolute/);
    expect(() => terminalInputArgsSchema.parse(["term-1", "x".repeat(65 * 1024)])).toThrow();
    expect(() => terminalResizeArgsSchema.parse(["term-1", 0, 24])).toThrow();
    expect(() => terminalResizeArgsSchema.parse(["term-1", 80, Number.NaN])).toThrow();
  });

  it("requires session workspaces to be existing absolute directories", () => {
    const root = tempDir();
    expect(sessionWorkspaceArgsSchema.parse(["session-1", root])).toEqual(["session-1", root]);
    expect(() => sessionWorkspaceArgsSchema.parse(["session-1", "../relative"])).toThrow();
    expect(() => sessionWorkspaceArgsSchema.parse(["session-1", path.join(root, "missing")])).toThrow();
  });

  it("bounds chat attachments and enforces kind/MIME consistency", () => {
    const image = {
      id: "a1",
      name: "photo.png",
      mimeType: "image/png",
      size: 3,
      dataUrl: "data:image/png;base64,AA==",
      kind: "image" as const,
    };
    expect(chatSendArgsSchema.parse(["s1", "look", [image], process.cwd(), undefined, "manual"]))
      .toBeTruthy();
    expect(() => chatSendArgsSchema.parse([
      "s1", "look", [{ ...image, mimeType: "text/html" }], process.cwd(), undefined, "manual",
    ])).toThrow(/MIME/);
    expect(() => chatSendArgsSchema.parse([
      "s1", "look", Array.from({ length: 11 }, (_, i) => ({ ...image, id: `a${i}` })),
    ])).toThrow();
  });

  it("validates automation schedule fields and rejects immutable update keys", () => {
    const daily = {
      title: "Daily report",
      instructions: "Summarize the day",
      scheduleType: "daily" as const,
      scheduleConfig: { time: "09:00", timezone: "Asia/Shanghai" },
      enabled: true,
    };
    expect(automationCreateSchema.parse(daily)).toEqual(daily);
    expect(() => automationCreateSchema.parse({
      ...daily,
      scheduleType: "weekly",
      scheduleConfig: { time: "09:00" },
    })).toThrow(/days/);
    expect(() => automationCreateSchema.parse({
      ...daily,
      scheduleType: "once",
      scheduleConfig: {},
    })).toThrow(/datetime/);
    expect(() => automationUpdateSchema.parse({ id: "forged", enabled: false })).toThrow();
  });

  it("rejects malformed settings and incomplete MCP transports", () => {
    const settings = {
      model: { provider: "anthropic", model: "claude", workspaceDir: "" },
      configuredModels: [],
      mcpServers: [],
      permissionMode: "manual",
      alwaysAllowTools: [],
      onboarded: true,
      trayEnabled: true,
      autoUpdate: true,
      openAtLogin: false,
      keepAwake: true,
      theme: "dark",
      language: "en-US",
      fontScale: 1,
      telemetry: false,
      showReasoning: true,
      funMode: false,
      logEnabled: false,
      memory: {
        autoExtract: false,
        embedding: { provider: "none", model: "" },
        topK: 10,
        threshold: 0.45,
      },
      memories: [],
      includeAgentsMd: true,
      includeClaudeMd: true,
    };
    expect(settingsSchema.parse(settings)).toEqual(settings);
    expect(() => settingsSchema.parse({ ...settings, permissionMode: "root" })).toThrow();
    expect(settingsSchema.parse({ ...settings, permissionMode: "auto-write" }).permissionMode).toBe("auto-write");
    expect(settingsSchema.parse({ ...settings, permissionMode: "auto-exec" }).permissionMode).toBe("auto-exec");
    expect(() => settingsSchema.parse({
      ...settings,
      mcpServers: [{ id: "m1", label: "Local", transport: "stdio", enabled: true }],
    })).toThrow(/command/);
    expect(() => settingsSchema.parse({ ...settings, fontScale: 99 })).toThrow();
  });
});
