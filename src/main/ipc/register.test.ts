// IPC 注册层的集成测试：聚焦"链路闭合"——渲染层的参数是否正确透传到主进程服务，
// 以及事件转发是否携带 sessionId（避免串 session）。不验证各业务模块的内部逻辑
// （那些在各自的单元测试里覆盖），只验证 registerIpc 这个接线是否正确。
//
// 通过 mock electron / agentManager / scheduler 等，把 registerIpc 跑起来，
// 再从捕获的 handler Map 中取出具体 handler 直接调用并断言。

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

vi.mock("better-sqlite3", () => import("../../test/mocks/better-sqlite3"));
vi.mock("electron", () => import("../../test/mocks/electron"));
import { __test_getHandlers } from "../../test/mocks/electron";

// ---- 主进程服务 mock ----
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
    listArtifacts: vi.fn(() => []),
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
vi.mock("../storage/automations", () => ({
  listAutomations: vi.fn(() => [{ id: "a1" }]),
  listAutomationsWithRuns: vi.fn(() => []),
  createAutomation: vi.fn(),
  updateAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  listRuns: vi.fn(() => []),
  deleteRun: vi.fn(),
  deleteRuns: vi.fn(),
}));
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

describe("ipc/register 链路闭合", () => {
  beforeAll(() => {
    registerIpc(() => null as any);
  });

  afterEach(() => {
    // 注意：registerIpc 只在 beforeAll 注册一次，handlers Map 不能清空，
    // 否则后续测试取不到 handler。只清 mock 调用记录即可。
    vi.clearAllMocks();
  });

  it("chat:send 把 mode 透传给 agentManager.runTurn（锁 C-T2 模式链路闭合）", async () => {
    const handlers = __test_getHandlers();
    const send = handlers.get("chat:send")!;
    const { event, sent } = makeEvent();

    await send(event, "sess-1", "do something", undefined, "/ws", "claude-x", "auto");

    // runTurn(sessionId, text, attachments, root, modelId, mode)
    expect(agent.runTurn).toHaveBeenCalledTimes(1);
    const args = agent.runTurn.mock.calls[0] as unknown as any[];
    expect(args[0]).toBe("sess-1");
    expect(args[1]).toBe("do something");
    expect(args[5]).toBe("auto"); // mode 透传
  });

  it("chat:send 的事件携带正确的 sessionId（不串 session）", async () => {
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

  it("chat:send 在 runTurn 抛错时推送 turn_error 事件而非崩溃", async () => {
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

  it("chat:cancel 调用 agentManager.cancel(sessionId)", () => {
    const handlers = __test_getHandlers();
    const cancel = handlers.get("chat:cancel")!;
    cancel({}, "sess-9");
    expect(agent.cancel).toHaveBeenCalledWith("sess-9");
  });

  it("chat:regenerate 调用 agentManager.regenerate 并转发事件", async () => {
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

  it("automations:runNow 从 listAutomations 找到目标后调用 scheduler.runNow", async () => {
    const handlers = __test_getHandlers();
    const runNow = handlers.get("automations:runNow")!;
    await runNow({}, "a1");
    expect(sched.runNow).toHaveBeenCalled();
  });

  // C-A3：timeline:read 在 IPC 边界先用 YYYY-MM-DD 正则校验 date，拒绝路径穿越
  // 载荷，且不会把非法值透传给存储层。timeline:path 同理。
  it("timeline:read 拒绝非法/穿越 date，不透传给 readTimelineDate（C-A3）", async () => {
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

    // 合法日期正常透传
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
});
