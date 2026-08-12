// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalMocks = vi.hoisted(() => ({
  write: vi.fn(), dispose: vi.fn(), open: vi.fn(), loadAddon: vi.fn(),
  inputHandler: undefined as ((data: string) => void) | undefined,
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24;
  loadAddon = terminalMocks.loadAddon; open = terminalMocks.open;
  write = terminalMocks.write; dispose = terminalMocks.dispose;
  onData(handler: (data: string) => void) { terminalMocks.inputHandler = handler; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, options?: { message?: string }) => options?.message ? `${key}:${options.message}` : key }) }));

import { TerminalPanel } from "./TerminalPanel";

describe("TerminalPanel", () => {
  let dataHandler: ((id: string, data: string) => void) | undefined;
  let offData: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    terminalMocks.inputHandler = undefined;
    offData = vi.fn();
    dataHandler = undefined;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    Object.defineProperty(window, "deepwork", { configurable: true, value: { terminal: {
      spawn: vi.fn(async () => undefined), input: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined), kill: vi.fn(async () => undefined),
      onData: vi.fn((cb) => { dataHandler = cb; return offData; }),
    } } });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("spawns, exchanges data, resizes, closes, and cleans up", async () => {
    const onClose = vi.fn();
    const { unmount } = render(<TerminalPanel sessionId="s1" cwd="/project" onClose={onClose} />);
    await waitFor(() => expect(window.deepwork.terminal.spawn).toHaveBeenCalledWith(expect.stringMatching(/^term-/), "s1"));
    const id = vi.mocked(window.deepwork.terminal.spawn).mock.calls[0][0];
    dataHandler?.(id, "output");
    expect(terminalMocks.write).toHaveBeenCalledWith("output");
    dataHandler?.("other", "ignored");
    expect(terminalMocks.write).toHaveBeenCalledTimes(1);
    terminalMocks.inputHandler?.("input");
    expect(window.deepwork.terminal.input).toHaveBeenCalledWith(id, "input");
    fireEvent.click(screen.getByTitle("terminal.close"));
    expect(onClose).toHaveBeenCalled();
    unmount();
    expect(window.deepwork.terminal.kill).toHaveBeenCalledWith(id);
    expect(offData).toHaveBeenCalled();
    expect(terminalMocks.dispose).toHaveBeenCalled();
  });

  it("shows spawn failures instead of crashing the app", async () => {
    vi.mocked(window.deepwork.terminal.spawn).mockRejectedValueOnce(new Error("pty unavailable"));
    render(<TerminalPanel sessionId="s1" onClose={vi.fn()} />);
    expect(await screen.findByText("terminal.startFailed:pty unavailable")).toBeTruthy();
  });

  it("kills the old PTY and starts a new one when the session changes", async () => {
    const { rerender } = render(<TerminalPanel sessionId="s1" onClose={vi.fn()} />);
    await waitFor(() => expect(window.deepwork.terminal.spawn).toHaveBeenCalledTimes(1));
    const oldId = vi.mocked(window.deepwork.terminal.spawn).mock.calls[0][0];
    rerender(<TerminalPanel sessionId="s2" onClose={vi.fn()} />);
    await waitFor(() => expect(window.deepwork.terminal.spawn).toHaveBeenCalledTimes(2));
    expect(window.deepwork.terminal.kill).toHaveBeenCalledWith(oldId);
    expect(vi.mocked(window.deepwork.terminal.spawn).mock.calls[1][1]).toBe("s2");
  });
});
