import { randomUUID } from "node:crypto";

export type TurnState = "idle" | "running" | "cancelling" | "completed" | "error";

/** Owns abort controllers and the current turn identity for each session. */
export class TurnRuntime {
  private readonly controllers = new Map<string, AbortController>();
  private readonly activeBySession = new Map<string, string>();
  private readonly stateBySession = new Map<string, TurnState>();

  start(sessionId: string): { turnId: string; controller: AbortController } {
    const turnId = randomUUID();
    const controller = new AbortController();
    this.controllers.set(turnId, controller);
    this.activeBySession.set(sessionId, turnId);
    this.stateBySession.set(sessionId, "running");
    return { turnId, controller };
  }

  activeTurnId(sessionId: string): string | undefined {
    return this.activeBySession.get(sessionId);
  }

  state(sessionId: string): TurnState {
    return this.stateBySession.get(sessionId) ?? "idle";
  }

  cancel(sessionId: string): boolean {
    const turnId = this.activeBySession.get(sessionId);
    const controller = turnId ? this.controllers.get(turnId) : undefined;
    if (!controller || controller.signal.aborted) return false;
    this.stateBySession.set(sessionId, "cancelling");
    controller.abort();
    return true;
  }

  finish(sessionId: string, turnId: string, state: "completed" | "error"): void {
    this.controllers.delete(turnId);
    if (this.activeBySession.get(sessionId) === turnId) {
      this.activeBySession.delete(sessionId);
      this.stateBySession.set(sessionId, state);
    }
  }

  forget(sessionId: string): void {
    this.cancel(sessionId);
    const turnId = this.activeBySession.get(sessionId);
    if (turnId) this.controllers.delete(turnId);
    this.activeBySession.delete(sessionId);
    this.stateBySession.delete(sessionId);
  }
}
