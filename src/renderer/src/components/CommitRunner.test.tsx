// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitRunner } from "./CommitRunner";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const context = {
  scale: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(),
  moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(),
  fillText: vi.fn(), arcTo: vi.fn(), closePath: vi.fn(),
  fillStyle: "", strokeStyle: "", lineWidth: 0, font: "", textAlign: "", textBaseline: "",
};

describe("CommitRunner", () => {
  let queuedFrame: FrameRequestCallback | undefined;
  const mediaRemove = vi.fn();
  const disconnect = vi.fn();

  beforeEach(() => {
    queuedFrame = undefined;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.stubGlobal("requestAnimationFrame", vi.fn((cb: FrameRequestCallback) => { queuedFrame = cb; return 7; }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("MutationObserver", class { observe() {} disconnect = disconnect; });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({
      matches: false, addEventListener: vi.fn(), removeEventListener: mediaRemove,
    })) });
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
    localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("draws the ready state and responds to pointer and keyboard input", () => {
    render(<CommitRunner />);
    const canvas = document.querySelector("canvas")!;
    expect(screen.getByText("chat.dinoTitle")).toBeTruthy();
    queuedFrame?.(0);
    expect(context.fillText).toHaveBeenCalledWith(expect.stringContaining("chat.dinoReady"), 150, 66);
    fireEvent.click(canvas);
    fireEvent.keyDown(window, { code: "Space" });
    fireEvent.touchStart(canvas);
    expect(requestAnimationFrame).toHaveBeenCalled();
  });

  it("ignores game shortcuts while typing", () => {
    render(<><input aria-label="editor" /><CommitRunner /></>);
    screen.getByLabelText("editor").focus();
    const event = new KeyboardEvent("keydown", { code: "Space", cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("cancels animation and removes observers/listeners on unmount", () => {
    const { unmount } = render(<CommitRunner />);
    unmount();
    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
    expect(mediaRemove).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
