import { EventEmitter } from "node:events";
import { createSession } from "../storage/sessions";
import {
  listAutomations,
  listDueAutomations,
  markAutomationRun,
  startRun,
  finishRun,
  updateAutomation,
} from "../storage/automations";
import type { Automation, AutomationRun } from "../../shared/types";

// Minimal cron matcher: supports "*", step (every N), lists "a,b,c", ranges "a-b".
function fieldMatches(pattern: string, value: number, min: number, max: number): boolean {
  for (const part of pattern.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    let range = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    let lo = min;
    let hi = max;
    if (range !== "*") {
      if (range.includes("-")) {
        const [a, b] = range.split("-").map(Number);
        lo = a;
        hi = b;
      } else {
        const n = Number(range);
        if (Number.isNaN(n)) return false;
        lo = hi = n;
      }
    }
    for (let v = lo; v <= hi; v += step) {
      if (v === value) return true;
    }
  }
  return false;
}

function cronMatches(expr: string, d: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return (
    fieldMatches(parts[0], d.getMinutes(), 0, 59) &&
    fieldMatches(parts[1], d.getHours(), 0, 23) &&
    fieldMatches(parts[2], d.getDate(), 1, 31) &&
    fieldMatches(parts[3], d.getMonth() + 1, 1, 12) &&
    fieldMatches(parts[4], d.getDay(), 0, 6)
  );
}

/** Next fire time for a cron expression (minute granularity). */
function nextCronFire(expr: string, from: Date): Date | null {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (cronMatches(expr, d)) return new Date(d);
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

export interface SchedulerHandlers {
  /** Runs an automation turn; should stream events and return when the turn ends. */
  runAutomationTurn: (
    sessionId: string,
    instructions: string,
    onEvent: (e: unknown) => void,
  ) => Promise<void>;
}

/**
 * Lightweight in-process scheduler. Ticks every 30s. Fires cron automations
 * (at most once per minute per automation) and due one-shot tasks. Each run gets
 * its own session so transcripts live in the chat history.
 */
class AutomationScheduler extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private handlers: SchedulerHandlers | null = null;
  /** automationId -> last fire minute (epoch ms rounded down) */
  private lastFire = new Map<string, number>();
  private running = new Set<string>();

  init(handlers: SchedulerHandlers): void {
    this.handlers = handlers;
  }

  start(): void {
    if (this.timer) return;
    // Catch up any one-shots that came due while the app was closed.
    void this.catchUpOnce();
    this.timer = setInterval(() => void this.tick(), 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async previewNext(schedule: string): Promise<Date | null> {
    if (schedule === "once") return null;
    return nextCronFire(schedule, new Date());
  }

  private async catchUpOnce(): Promise<void> {
    const due = listDueAutomations(Date.now());
    for (const a of due) {
      if (!a.runAt) continue;
      await this.fire(a);
      // One-shot fired — disable it.
      updateAutomation(a.id, { enabled: false });
    }
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60_000) * 60_000;
    let automations: Automation[];
    try {
      automations = listAutomations();
    } catch {
      return;
    }
    for (const a of automations) {
      if (!a.enabled || this.running.has(a.id)) continue;
      if (a.schedule === "once") {
        if (a.runAt && new Date(a.runAt).getTime() <= now.getTime()) {
          await this.fire(a);
          updateAutomation(a.id, { enabled: false });
        }
        continue;
      }
      if (this.lastFire.get(a.id) === minute) continue;
      if (cronMatches(a.schedule, now)) {
        this.lastFire.set(a.id, minute);
        await this.fire(a);
      }
    }
  }

  private async fire(a: Automation): Promise<void> {
    if (!this.handlers) return;
    this.running.add(a.id);
    const session = createSession(`⏰ ${a.title}`);
    const run = startRun(a.id, session.id);
    this.emit("run:started", { automation: a, run });
    try {
      await this.handlers.runAutomationTurn(
        session.id,
        a.instructions,
        (event) => this.emit("run:event", { automationId: a.id, sessionId: session.id, event }),
      );
      finishRun(run.id, "success");
      markAutomationRun(a.id, "success", Date.now());
      this.emit("run:finished", { automation: a, run, sessionId: session.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finishRun(run.id, "error", message);
      markAutomationRun(a.id, "error", Date.now());
      this.emit("run:error", { automation: a, run, error: message, sessionId: session.id });
    } finally {
      this.running.delete(a.id);
    }
  }

  /** Manually trigger an automation now. */
  async runNow(a: Automation): Promise<void> {
    if (this.running.has(a.id)) return;
    await this.fire(a);
  }
}

export const scheduler = new AutomationScheduler();
