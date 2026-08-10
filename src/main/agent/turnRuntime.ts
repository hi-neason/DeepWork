import { randomUUID } from "node:crypto";
import type { TurnState, TurnStatus } from "../../shared/types";

export type { TurnState } from "../../shared/types";

interface ActiveTurn {
  turnId: string;
  controller: AbortController;
  startedAt: number;
}

/** Owns abort controllers and the current turn identity for each session. */
export class TurnRuntime {
  private readonly controllers = new Map<string, AbortController>();
  private readonly activeBySession = new Map<string, ActiveTurn>();
  private readonly stateBySession = new Map<string, TurnState>();

  start(sessionId: string): { turnId: string; controller: AbortController; startedAt: number } {
    const turnId = randomUUID();
    const controller = new AbortController();
    const startedAt = Date.now();
    this.controllers.set(turnId, controller);
    this.activeBySession.set(sessionId, { turnId, controller, startedAt });
    this.stateBySession.set(sessionId, "running");
    return { turnId, controller, startedAt };
  }

  activeTurnId(sessionId: string): string | undefined {
    return this.activeBySession.get(sessionId)?.turnId;
  }

  state(sessionId: string): TurnState {
    return this.stateBySession.get(sessionId) ?? "idle";
  }

  status(sessionId: string): TurnStatus {
    const active = this.activeBySession.get(sessionId);
    return {
      state: this.state(sessionId),
      ...(active ? { turnId: active.turnId, startedAt: active.startedAt } : {}),
    };
  }

  setState(sessionId: string, turnId: string, state: TurnState): boolean {
    if (this.activeBySession.get(sessionId)?.turnId !== turnId) return false;
    this.stateBySession.set(sessionId, state);
    return true;
  }

  cancel(sessionId: string): boolean {
    const turnId = this.activeBySession.get(sessionId)?.turnId;
    const controller = turnId ? this.controllers.get(turnId) : undefined;
    if (!controller || controller.signal.aborted) return false;
    this.stateBySession.set(sessionId, "cancelling");
    controller.abort();
    return true;
  }

  finish(sessionId: string, turnId: string, state: "completed" | "cancelled" | "error"): void {
    this.controllers.delete(turnId);
    if (this.activeBySession.get(sessionId)?.turnId === turnId) {
      this.activeBySession.delete(sessionId);
      this.stateBySession.set(sessionId, state);
    }
  }

  forget(sessionId: string): void {
    this.cancel(sessionId);
    const turnId = this.activeBySession.get(sessionId)?.turnId;
    if (turnId) this.controllers.delete(turnId);
    this.activeBySession.delete(sessionId);
    this.stateBySession.delete(sessionId);
  }
}
