// Integration test for the IPC registration layer: focuses on "wiring closure" —
// whether renderer arguments are correctly passed through to main-process
// services, and whether event forwarding carries the sessionId (to avoid
// cross-session mixing). It does not verify the internal logic of each business
// module (those are covered by their own unit tests); it only verifies that the
// registerIpc wiring is correct.
//
// By mocking electron / agentManager / scheduler, etc., registerIpc is set up,
// and then concrete handlers are pulled from the captured handler Map and
// invoked directly with assertions.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

vi.mock("better-sqlite3", () => import("../../test/mocks/better-sqlite3"));
vi.mock("electron", () => import("../../test/mocks/electron"));
import { __test_getHandlers, dialog, shell } from "../../test/mocks/electron";

// ---- main-process service mocks ----
const agent = vi.hoisted(() => {
  const runTurn = vi.fn(async function* () {
    yield { type: "message_delta", text: "hi" } as any;
    yield { type: "turn_completed" } as any;
  });
  const regenerate = vi.fn(async function* () {
    yield { type: "turn_completed" } as any;
  });
  return {
    runTurn,
    cancel: vi.fn(),
    regenerate,
    setSessionRoot: vi.fn(),
    setSessionModel: vi.fn(),
    getHistory: vi.fn(() => []),
    rebuildSkills: vi.fn(),
    rebuild: vi.fn(),
    getMcpStatus: vi.fn(() => []),
    getTurnStatus: vi.fn((): { state: string; turnId?: string; startedAt?: number } => ({ state: "idle" })),
    listArtifacts: vi.fn((_sessionId?: string): Array<{
      name: string;
      relativePath: string;
      absolutePath: string;
      size: number;
      modifiedAt: number;
      ext: string;
    }> => []),
    runUnattendedTurn: vi.fn(async function* () {}),
    setSender: vi.fn(),
  };
});
vi.mock("../agent/manager", () => ({ agentManager: agent }));

const sched = vi.hoisted(() => ({
  init: vi.fn(),
  start: vi.fn(),
  on: vi.fn(),
  runNow: vi.fn(),
}));
vi.mock("../automation/scheduler", () => ({ scheduler: sched }));

const term = vi.hoisted(() => ({
  setSender: vi.fn(),
  spawn: vi.fn(),
  input: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
}));
vi.mock("../terminal/manager", () => ({ terminalManager: term }));

const mcpTrust = vi.hoisted(() => ({
  loadMcpTrustGrants: vi.fn(() => ({} as Record<string, string>)),
  safeMcpApprovalDetail: vi.fn((server: { id: string; command?: string; env?: Record<string, string> }) =>
    `ID: ${server.id}\nCommand: ${server.command ?? ""}\nEnvironment variables: ${Object.keys(server.env ?? {}).join(", ")}`,
  ),
  saveMcpTrustGrants: vi.fn(),
  serversRequiringApproval: vi.fn(() => [] as any[]),
}));
vi.mock("../security/mcpTrust", () => mcpTrust);

vi.mock("../system", () => ({
  applyOpenAtLogin: vi.fn(),
  setKeepAwake: vi.fn(),
}));

vi.mock("../config/paths", () => ({
  DEEPWORK_ROOT: "/tmp/dw",
  APP_DATA_DIR: "/tmp/dw",
  DEFAULT_WORKSPACE_DIR: "/tmp/dw/default",
  sessionRootDir: vi.fn(() => "/tmp/dw/root"),
  sessionArtifactsDir: vi.fn(() => "/tmp/dw/art"),
  hasPickedWorkspace: vi.fn(() => false),
}));

vi.mock("../storage/sessions", () => ({
  getSession: vi.fn(() => undefined),
  setSessionModel: vi.fn(),
  listSessions: vi.fn(() => []),
  createSession: vi.fn(),
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
  setSessionGroup: vi.fn(),
  setSessionWorkspace: vi.fn(),
  listGroups: vi.fn(() => []),
  renameGroup: vi.fn(),
  deleteGroup: vi.fn(),
  createGroup: vi.fn(),
  groupForWorkspace: vi.fn(() => "default"),
  touchSession: vi.fn(),
}));
import * as sessions from "../storage/sessions";
import * as configPaths from "../config/paths";
vi.mock("../storage/timeline-memory", () => ({
  listTimelineDates: vi.fn(() => []),
  readTimelineDate: vi.fn(() => ""),
  timelinePath: vi.fn(() => "/tmp/dw/tl.md"),
}));
import * as timelineMemory from "../storage/timeline-memory";
vi.mock("../storage/project-memory", () => ({
  listProjects: vi.fn(() => []),
  readProjectMemory: vi.fn(() => ""),
  projectMemoryPath: vi.fn(() => "/tmp/dw/p.md"),
}));
import * as projectMemory from "../storage/project-memory";
vi.mock("../storage/automations", () => ({
  listAutomations: vi.fn(() => [{ id: "a1" }]),
  listAutomationsWithRuns: vi.fn(() => []),
  createAutomation: vi.fn(),
  getAutomation: vi.fn(() => null),
  updateAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  listRuns: vi.fn(() => []),
  deleteRun: vi.fn(),
  deleteRuns: vi.fn(),
}));
import * as automationStorage from "../storage/automations";
vi.mock("../storage/skills/store", () => ({
  listSkills: vi.fn(() => []),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
  renameSkill: vi.fn(),
  importSkill: vi.fn(),
  exportSkill: vi.fn(),
}));
vi.mock("../storage/settings", () => ({
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  getApiKey: vi.fn(() => null),
  setApiKey: vi.fn(),
}));
import * as settingsStorage from "../storage/settings";
vi.mock("../storage/memories", () => ({
  listAllMemories: vi.fn(() => []),
  listMemoriesByScope: vi.fn(() => []),
  searchMemories: vi.fn(() => []),
  addMemory: vi.fn(),
  editMemory: vi.fn(),
  removeMemory: vi.fn(),
}));
vi.mock("../storage/user-memory", () => ({
  readUserMemory: vi.fn(() => []),
  saveUserMemory: vi.fn(),
  appendToRecent: vi.fn(),
  readRawMemory: vi.fn(() => ""),
  saveRawMemory: vi.fn(),
  MEMORY_FILE: "/tmp/mf.md",
  MEMORY_SECTIONS: ["background", "approaches", "focus", "updates"],
}));
vi.mock("../agent/model", () => ({
  verifyModelConfig: vi.fn(() => Promise.resolve({ ok: true })),
}));
vi.mock("../log/logger", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { registerIpc } from "./register";
import { approvals } from "../security/approvals";

function makeEvent() {
  const sent: Array<{ channel: string; sessionId: string; event: any }> = [];
  const sender = {
    isDestroyed: () => false,
    send: (channel: string, sessionId: string, event: any) =>
      sent.push({ channel, sessionId, event }),
  };
  return { event: { sender }, sent };
}

function validSettings(mcpServers: any[] = []) {
  return {
    model: { provider: "anthropic", model: "claude", workspaceDir: "" },
    configuredModels: [],
    mcpServers,
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
}

describe("ipc/register wiring closure", () => {
  beforeAll(() => {
    registerIpc(() => null as any);
  });

  afterEach(() => {
    // Note: registerIpc is registered only once in beforeAll; the handlers Map
    // must not be cleared, otherwise later tests cannot retrieve handlers.
    // Only clear mock call records.
    vi.clearAllMocks();
  });

  it("sessions:create uses the configured default workspace when no project is selected", async () => {
    vi.mocked(settingsStorage.loadSettings).mockReturnValueOnce({
      model: { workspaceDir: "/configured/default" },
    } as any);

    await __test_getHandlers().get("sessions:create")!({}, undefined, undefined, undefined);

    expect(sessions.createSession).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      "user",
      "/configured/default",
    );
  });

  it("chat:send passes mode through to agentManager.runTurn (locks C-T2 mode wiring closure)", async () => {
    const handlers = __test_getHandlers();
    const send = handlers.get("chat:send")!;
    const { event, sent } = makeEvent();

    await send(event, "sess-1", "do something", undefined, process.cwd(), "claude-x", "auto");

    // runTurn(sessionId, text, attachments, root, modelId, mode)
    expect(agent.runTurn).toHaveBeenCalledTimes(1);
    const args = agent.runTurn.mock.calls[0] as unknown as any[];
    expect(args[0]).toBe("sess-1");
    expect(args[1]).toBe("do something");
    expect(args[5]).toBe("auto"); // mode passed through
  });

  it("chat:send events carry the correct sessionId (no cross-session mixing)", async () => {
    const handlers = __test_getHandlers();
    const send = handlers.get("chat:send")!;

    const a = makeEvent();
    await send(a.event, "session-A", "hi", undefined, undefined, undefined, "manual");
    const b = makeEvent();
    await send(b.event, "session-B", "yo", undefined, undefined, undefined, "auto");

    expect(a.sent.every((s) => s.sessionId === "session-A")).toBe(true);
    expect(b.sent.every((s) => s.sessionId === "session-B")).toBe(true);
    expect(a.sent[0].channel).toBe("chat:event");
  });

  it("chat:send pushes a turn_error event instead of crashing when runTurn throws", async () => {
    const handlers = __test_getHandlers();
    const send = handlers.get("chat:send")!;
    agent.runTurn.mockImplementationOnce(async function* () {
      throw new Error("boom");
    });
    const { event, sent } = makeEvent();

    await send(event, "sess-err", "x");

    const err = sent.find((s) => s.event.type === "turn_error");
    expect(err).toBeTruthy();
    expect(err!.event.message).toBe("boom");
  });

  it("chat:cancel calls agentManager.cancel(sessionId)", () => {
    const handlers = __test_getHandlers();
    const cancel = handlers.get("chat:cancel")!;
    cancel({}, "sess-9");
    expect(agent.cancel).toHaveBeenCalledWith("sess-9");
  });

  it("chat:status returns the authoritative main-process turn snapshot", async () => {
    agent.getTurnStatus.mockReturnValueOnce({
      state: "waiting_approval",
      turnId: "turn-1",
      startedAt: 42,
    });
    const status = __test_getHandlers().get("chat:status")!;
    await expect(status({}, "sess-9")).resolves.toEqual({
      state: "waiting_approval",
      turnId: "turn-1",
      startedAt: 42,
    });
  });

  it("chat:regenerate calls agentManager.regenerate and forwards events", async () => {
    const handlers = __test_getHandlers();
    const regen = handlers.get("chat:regenerate")!;
    const { event, sent } = makeEvent();

    await regen(event, "sess-r");

    expect(agent.regenerate).toHaveBeenCalledWith("sess-r");
    expect(sent.some((s) => s.event.type === "turn_completed")).toBe(true);
  });

  it("approval:respond 调用 approvals.respond(id, decision)", () => {
    const handlers = __test_getHandlers();
    const respond = handlers.get("approval:respond")!;
    const spy = vi.spyOn(approvals, "respond");

    respond({}, "req-1", "allow");

    expect(spy).toHaveBeenCalledWith("req-1", "allow");
    spy.mockRestore();
  });

  it("automations:runNow finds the target from listAutomations and then calls scheduler.runNow", async () => {
    const handlers = __test_getHandlers();
    const runNow = handlers.get("automations:runNow")!;
    await runNow({}, "a1");
    expect(sched.runNow).toHaveBeenCalled();
  });

  // C-A3: timeline:read validates date with a YYYY-MM-DD regex at the IPC boundary,
  // rejects path-traversal payloads, and does not pass invalid values through to the
  // storage layer. timeline:path behaves the same way.
  it("timeline:read rejects invalid/traversing date values and does not pass them to readTimelineDate (C-A3)", async () => {
    const handlers = __test_getHandlers();
    const read = handlers.get("timeline:read")!;
    const readSpy = vi.mocked(timelineMemory.readTimelineDate);

    for (const bad of [
      "../../secret",
      "2026-08-08/../../x",
      "not-a-date",
      "",
      "../etc/passwd",
    ]) {
      await expect(read({}, bad)).rejects.toThrow();
      expect(readSpy).not.toHaveBeenCalledWith(bad);
    }
    readSpy.mockClear();

    // A valid date is passed through normally
    await read({}, "2026-08-08");
    expect(readSpy).toHaveBeenCalledWith("2026-08-08");
  });

  it("timeline:path 拒绝非法 date（C-A3 边界校验）", async () => {
    const handlers = __test_getHandlers();
    const pathHandler = handlers.get("timeline:path")!;
    const pathSpy = vi.mocked(timelineMemory.timelinePath);

    await expect(pathHandler({}, "../../x")).rejects.toThrow();
    expect(pathSpy).not.toHaveBeenCalled();

    await pathHandler({}, "2026-08-08");
    expect(pathSpy).toHaveBeenCalledWith("2026-08-08");
  });

  it("terminal:spawn derives cwd from the stored session instead of renderer input", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "deepwork-project-ipc-"));
    const sessionWorkspace = path.join(project, ".deepwork", "sessions", "sess-pty");
    try {
      vi.mocked(sessions.getSession).mockReturnValueOnce({
        id: "sess-pty",
        title: "Terminal",
        createdAt: 1,
        updatedAt: 1,
        source: "user",
        group: "Default",
        workspaceDir: project,
        rootDir: sessionWorkspace,
        terminalCwd: sessionWorkspace,
      });
      vi.mocked(configPaths.hasPickedWorkspace).mockReturnValueOnce(true);

      await __test_getHandlers().get("terminal:spawn")!({}, "term-1", "sess-pty");

      expect(fs.statSync(sessionWorkspace).isDirectory()).toBe(true);
      expect(term.spawn).toHaveBeenCalledWith("term-1", sessionWorkspace);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("terminal:spawn repairs an older default session directory before opening the PTY", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "deepwork-terminal-ipc-"));
    const root = path.join(base, "sessions", "sess-old");
    try {
      vi.mocked(sessions.getSession).mockReturnValueOnce({
        id: "sess-old",
        title: "Legacy terminal",
        createdAt: 1,
        updatedAt: 1,
        source: "user",
        group: "Default",
        workspaceDir: "/tmp/dw/default",
      });
      vi.mocked(configPaths.hasPickedWorkspace).mockReturnValueOnce(false);
      vi.mocked(configPaths.sessionRootDir).mockReturnValueOnce(root);

      await __test_getHandlers().get("terminal:spawn")!({}, "term-old", "sess-old");

      expect(fs.statSync(root).isDirectory()).toBe(true);
      expect(term.spawn).toHaveBeenCalledWith("term-old", root);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("terminal handlers reject malformed ids and PTY dimensions at the IPC boundary", async () => {
    const handlers = __test_getHandlers();
    await expect(handlers.get("terminal:spawn")!({}, "", "sess-1")).rejects.toThrow();
    await expect(handlers.get("terminal:resize")!({}, "term-1", -1, 24)).rejects.toThrow();
    expect(term.spawn).not.toHaveBeenCalled();
    expect(term.resize).not.toHaveBeenCalled();
  });

  it("artifacts:open requires the file to belong to the supplied session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepwork-artifact-ipc-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "deepwork-artifact-outside-"));
    try {
      const allowed = path.join(root, "report.txt");
      const forbidden = path.join(outside, "secret.txt");
      fs.writeFileSync(allowed, "report");
      fs.writeFileSync(forbidden, "secret");
      vi.mocked(sessions.getSession).mockReturnValue({
        id: "sess-art",
        title: "Artifacts",
        createdAt: 1,
        updatedAt: 1,
        source: "user",
        group: "Default",
      });
      vi.mocked(configPaths.sessionArtifactsDir).mockReturnValue(root);
      agent.listArtifacts.mockReturnValueOnce([{
        name: "report.txt",
        relativePath: "report.txt",
        absolutePath: allowed,
        size: 6,
        modifiedAt: 1,
        ext: "txt",
      }]);
      const openSpy = vi.spyOn(shell, "openPath");
      const open = __test_getHandlers().get("artifacts:open")!;

      await open({}, "sess-art", allowed);
      expect(openSpy).toHaveBeenCalledWith(fs.realpathSync(allowed));
      await expect(open({}, "sess-art", forbidden)).rejects.toThrow(/outside/);
      expect(openSpy).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects untrusted workspace paths before session storage is called", async () => {
    const setWorkspace = __test_getHandlers().get("sessions:setWorkspace")!;
    await expect(setWorkspace({}, "sess-1", "../../outside")).rejects.toThrow(/Workspace/);
    expect(sessions.setSessionWorkspace).not.toHaveBeenCalled();
  });

  it("rejects malformed attachments before starting an agent turn", async () => {
    const send = __test_getHandlers().get("chat:send")!;
    const { event } = makeEvent();
    await expect(send(event, "sess-1", "inspect", [{
      id: "a1",
      name: "payload.html",
      mimeType: "text/html",
      size: 10,
      dataUrl: "data:text/html;base64,AA==",
      kind: "image",
    }])).rejects.toThrow(/MIME/);
    expect(agent.runTurn).not.toHaveBeenCalled();
  });

  it("rejects forged automation fields before reading or updating storage", async () => {
    const update = __test_getHandlers().get("automations:update")!;
    await expect(update({}, "a1", { createdAt: 0, enabled: false })).rejects.toThrow();
    expect(automationStorage.getAutomation).not.toHaveBeenCalled();
    expect(automationStorage.updateAutomation).not.toHaveBeenCalled();
  });

  it("rejects malformed settings before persistence", async () => {
    const save = __test_getHandlers().get("settings:save")!;
    await expect(save({}, { permissionMode: "root" })).rejects.toThrow();
    expect(settingsStorage.saveSettings).not.toHaveBeenCalled();
  });

  it("does not persist settings or grants when native MCP approval is denied", async () => {
    const server = {
      id: "local",
      label: "Local MCP",
      transport: "stdio" as const,
      command: "node",
      args: ["server.js"],
      env: { API_TOKEN: "top-secret" },
      enabled: true,
    };
    mcpTrust.serversRequiringApproval.mockReturnValueOnce([server]);
    vi.spyOn(dialog, "showMessageBox").mockResolvedValueOnce({ response: 0 } as any);
    const save = __test_getHandlers().get("settings:save")!;

    await expect(save({}, validSettings([server]))).rejects.toThrow(/not approved/i);

    expect(settingsStorage.saveSettings).not.toHaveBeenCalled();
    expect(mcpTrust.saveMcpTrustGrants).not.toHaveBeenCalled();
  });

  it("persists an approved fingerprint before saving settings without exposing env values", async () => {
    const server = {
      id: "local",
      label: "Local MCP",
      transport: "stdio" as const,
      command: "node",
      args: ["server.js"],
      env: { API_TOKEN: "top-secret" },
      enabled: true,
    };
    const settings = validSettings([server]);
    mcpTrust.serversRequiringApproval.mockReturnValueOnce([server]);
    const prompt = vi.spyOn(dialog, "showMessageBox").mockResolvedValueOnce({ response: 1 } as any);
    const save = __test_getHandlers().get("settings:save")!;

    await save({}, settings);

    const call = prompt.mock.calls[0];
    const options = call[call.length - 1] as unknown as { detail: string };
    expect(options.detail).toContain("API_TOKEN");
    expect(options.detail).not.toContain("top-secret");
    expect(mcpTrust.saveMcpTrustGrants).toHaveBeenCalledWith(
      settings.mcpServers,
      new Set(["local"]),
      {},
    );
    expect(mcpTrust.saveMcpTrustGrants.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(settingsStorage.saveSettings).mock.invocationCallOrder[0]);
  });

  it("bounds project-memory identifiers before filesystem access", async () => {
    const read = __test_getHandlers().get("projectMemory:read")!;
    await expect(read({}, "x".repeat(256))).rejects.toThrow();
    expect(projectMemory.readProjectMemory).not.toHaveBeenCalled();
  });
});
