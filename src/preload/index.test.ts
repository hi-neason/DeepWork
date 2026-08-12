import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepWorkApi } from "./index";

const electronMock = vi.hoisted(() => ({
  exposed: undefined as unknown,
  invoke: vi.fn(async () => undefined),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn((_name: string, api: unknown) => { electronMock.exposed = api; }) },
  ipcRenderer: { invoke: electronMock.invoke, on: electronMock.on, removeListener: electronMock.removeListener },
}));

let api: DeepWorkApi;

beforeAll(async () => {
  await import("./index");
  api = electronMock.exposed as DeepWorkApi;
});
beforeEach(() => vi.clearAllMocks());

describe("preload bridge", () => {
  it.each([
    ["sessions.list", () => api.sessions.list(), ["sessions:list"]],
    ["sessions.create", () => api.sessions.create("title", "/tmp", "model", "plan"), ["sessions:create", "title", "/tmp", "model", "plan"]],
    ["settings.setKey", () => api.settings.setKey("openai", "secret"), ["settings:setKey", "openai", "secret"]],
    ["automations.update", () => api.automations.update("a1", { enabled: false }), ["automations:update", "a1", { enabled: false }]],
    ["terminal.resize", () => api.terminal.resize("t1", 80, 24), ["terminal:resize", "t1", 80, 24]],
  ])("forwards %s arguments without reshaping", async (_name, call, expected) => {
    await call();
    expect(electronMock.invoke).toHaveBeenCalledWith(...expected);
  });

  it("filters session events and unsubscribes the exact listener", () => {
    const cb = vi.fn();
    const off = api.chat.onEvent("s1", cb);
    const listener = electronMock.on.mock.calls[0][1] as (...args: unknown[]) => void;
    listener({}, "s2", { type: "turn_completed" });
    listener({}, "s1", { type: "turn_completed" });
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    expect(electronMock.removeListener).toHaveBeenCalledWith("chat:event", listener);
  });

  it("forwards any-session and update/terminal events and cleans them up", () => {
    const chatCb = vi.fn();
    const updateCb = vi.fn();
    const terminalCb = vi.fn();
    const offs = [api.chat.onAnyEvent(chatCb), api.updates.onStatus(updateCb), api.terminal.onData(terminalCb)];
    const listeners = electronMock.on.mock.calls.map((call) => call[1] as (...args: unknown[]) => void);
    listeners[0]({}, "s1", { type: "turn_aborted" });
    listeners[1]({}, { state: "checking" });
    listeners[2]({}, "t1", "output");
    expect(chatCb).toHaveBeenCalledWith("s1", { type: "turn_aborted" });
    expect(updateCb).toHaveBeenCalledWith({ state: "checking" });
    expect(terminalCb).toHaveBeenCalledWith("t1", "output");
    offs.forEach((off) => off());
    expect(electronMock.removeListener).toHaveBeenCalledTimes(3);
  });
});
