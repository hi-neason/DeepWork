// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useTurnWatchdog,
  TURN_LIVENESS_TIMEOUT_MS,
} from "./useTurnWatchdog";

describe("useTurnWatchdog (H: streaming 卡死兜底)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("streaming=true 后超过窗口未收到事件 → 触发 onTimeout", () => {
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

  it("收到事件（poke）会重置窗口；持续有事件则不超时", () => {
    const onTimeout = vi.fn();
    const { result, rerender } = renderHook(
      ({ streaming }) => useTurnWatchdog(streaming, onTimeout, 1000),
      { initialProps: { streaming: true } },
    );

    // 每隔 900ms 来一个事件，累计超过窗口也不应超时
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(900);
      result.current(); // poke
    }
    expect(onTimeout).not.toHaveBeenCalled();

    // 停止 poke 后，满窗口才超时
    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("streaming 变为 false（收到终态事件）立即清除定时器，不触发 onTimeout", () => {
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

  it("只在超时时触发一次，不会因定时器重复触发", () => {
    const onTimeout = vi.fn();
    renderHook(() => useTurnWatchdog(true, onTimeout, 1000));
    vi.advanceTimersByTime(5000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("默认超时窗口为 3 分钟", () => {
    expect(TURN_LIVENESS_TIMEOUT_MS).toBe(3 * 60 * 1000);
  });
});
