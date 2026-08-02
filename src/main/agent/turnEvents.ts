import { EventEmitter } from "node:events";
import type { DeepWorkEvent } from "../../shared/types";

/** Per-turn emitters keyed by LangGraph thread_id. */
const emitters = new Map<string, EventEmitter>();

export function registerTurnEmitter(threadId: string, emitter: EventEmitter): void {
  emitters.set(threadId, emitter);
}

export function unregisterTurnEmitter(threadId: string): void {
  emitters.delete(threadId);
}

export function emitTurnEvent(threadId: string | undefined, e: DeepWorkEvent): void {
  if (!threadId) return;
  emitters.get(threadId)?.emit("event", e);
}
