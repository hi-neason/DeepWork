import { useCallback, useEffect, useRef } from "react";

/**
 * Default liveness window: if the agent emits no event (message delta, tool
 * call, reasoning, …) for this long while a turn is streaming, we consider the
 * turn hung and fire `onTimeout` so the UI can reset streaming / show an error.
 *
 * Three minutes is generous enough for slow reasoning models' first token while
 * still catching a wedged IPC channel or crashed agent that never emits a
 * terminal event (turn_completed / turn_error / turn_aborted).
 */
export const TURN_LIVENESS_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Enforce a liveness timeout for a streaming agent turn.
 *
 * Call the returned `poke` function on every incoming event to reset the
 * window. When `streaming` flips to false (terminal event) the timer is
 * cleared automatically. If the window elapses with no poke, `onTimeout`
 * fires exactly once.
 *
 * This closes the "UI stuck streaming forever" bug where chat.send resolves
 * but the agent never emits turn_completed / turn_error (IPC timeout, agent
 * crash, dropped event, …).
 */
export function useTurnWatchdog(
  streaming: boolean,
  onTimeout: () => void,
  timeoutMs: number = TURN_LIVENESS_TIMEOUT_MS,
): () => void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep the latest callback without re-arming the timer when it changes identity.
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  const clear = useCallback((): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const poke = useCallback((): void => {
    clear();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onTimeoutRef.current();
    }, timeoutMs);
  }, [clear, timeoutMs]);

  useEffect(() => {
    if (streaming) {
      poke();
    } else {
      clear();
    }
    return clear;
  }, [streaming, poke, clear]);

  return poke;
}
