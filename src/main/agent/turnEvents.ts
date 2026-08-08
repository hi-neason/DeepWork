import { EventEmitter } from "node:events";
import type { DeepWorkEvent } from "../../shared/types";

/**
 * Per-turn emitters keyed by a unique turn id. A thread (session) runs one
 * turn at a time; `activeTurnByThread` maps thread_id → the turn currently
 * owning live tool events, so a stale/abandoned turn can't hijack a new turn's
 * event stream (H-A1).
 */
const emitters = new Map<string, EventEmitter>();
const activeTurnByThread = new Map<string, string>();

export function registerTurnEmitter(
  turnId: string,
  threadId: string,
  emitter: EventEmitter,
): void {
  emitters.set(turnId, emitter);
  activeTurnByThread.set(threadId, turnId);
}

export function unregisterTurnEmitter(turnId: string, threadId: string): void {
  emitters.delete(turnId);
  // Only clear the active mapping if it still points at this turn — a newer
  // turn may have taken over in the meantime.
  if (activeTurnByThread.get(threadId) === turnId) {
    activeTurnByThread.delete(threadId);
  }
}

export function emitTurnEvent(
  threadId: string | undefined,
  e: DeepWorkEvent,
): void {
  if (!threadId) return;
  const turnId = activeTurnByThread.get(threadId);
  if (turnId) emitters.get(turnId)?.emit("event", e);
}
