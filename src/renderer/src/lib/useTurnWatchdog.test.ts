// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useTurnWatchdog,
  TURN_LIVENESS_TIMEOUT_MS,
} from "./useTurnWatchdog";

describe("useTurnWatchdog (H: streaming stall safety net)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("after streaming=true, no event within the window triggers onTimeout", () => {
    const onTimeout = vi.fn();
    const { rerender } = renderHook(
      ({ streaming }) => useTurnWatchdog(streaming, onTimeout, 1000),
      { initialProps: { streaming: false } },
    );

    rerender({ streaming: true });
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("receiving an event (poke) resets the window; continuous events do not time out", () => {
    const onTimeout = vi.fn();
    const { result, rerender } = renderHook(
      ({ streaming }) => useTurnWatchdog(streaming, onTimeout, 1000),
      { initialProps: { streaming: true } },
    );

    // An event every 900ms should not time out even cumulatively beyond the window
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(900);
      result.current(); // poke the watchdog
    }
    expect(onTimeout).not.toHaveBeenCalled();

    // After poke stops, a full window must elapse before timeout
    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("when streaming becomes false (terminal event received) the timer is cleared immediately without onTimeout", () => {
    const onTimeout = vi.fn();
    const { rerender } = renderHook(
      ({ streaming }) => useTurnWatchdog(streaming, onTimeout, 1000),
      { initialProps: { streaming: true } },
    );

    vi.advanceTimersByTime(500);
    rerender({ streaming: false });
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("fires only once on timeout and does not re-fire from the timer", () => {
    const onTimeout = vi.fn();
    renderHook(() => useTurnWatchdog(true, onTimeout, 1000));
    vi.advanceTimersByTime(5000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("default timeout window is 3 minutes", () => {
    expect(TURN_LIVENESS_TIMEOUT_MS).toBe(3 * 60 * 1000);
  });
});
