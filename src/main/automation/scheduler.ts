import { EventEmitter } from "node:events";
import { createSession } from "../storage/sessions";
import {
  listAutomations,
  listDueAutomations,
  markAutomationRun,
  startRun,
  finishRun,
  updateAutomation,
  getAutomation,
} from "../storage/automations";
import type { Automation, AutomationRun, AutomationScheduleConfig } from "../../shared/types";
import { logger } from "../log/logger";

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

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseTime(time?: string): { hour: number; minute: number } | null {
  if (!time) return null;
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return { hour: h, minute: m };
}

function isWithinValidity(a: Automation, now: Date): boolean {
  if (a.validFrom) {
    const from = new Date(a.validFrom + "T00:00:00");
    if (now.getTime() < from.getTime()) return false;
  }
  if (a.validUntil) {
    const until = new Date(a.validUntil + "T23:59:59.999");
    if (now.getTime() > until.getTime()) return false;
  }
  return true;
}

function shouldFire(a: Automation, now: Date): boolean {
  const cfg = a.scheduleConfig || {};
  const type = a.scheduleType || "daily";
  if (type === "once") {
    const dt = cfg.datetime || a.runAt;
    return !!dt && new Date(dt).getTime() <= now.getTime();
  }
  if (type === "daily") {
    const t = parseTime(cfg.time);
    if (!t) return false;
    return now.getHours() === t.hour && now.getMinutes() === t.minute;
  }
  if (type === "weekly") {
    const t = parseTime(cfg.time);
    if (!t) return false;
    const days = cfg.days ?? [];
    if (!days.includes(now.getDay())) return false;
    return now.getHours() === t.hour && now.getMinutes() === t.minute;
  }
  if (type === "cron") {
    const expr = cfg.cron || a.schedule;
    return !!expr && cronMatches(expr, now);
  }
  return false;
}

function describeSchedule(a: Automation): string {
  const cfg = a.scheduleConfig || {};
  switch (a.scheduleType) {
    case "daily":
      return cfg.time ? `每天 ${cfg.time}` : "每天";
    case "weekly": {
      const days = cfg.days ?? [];
      const names = ["日", "一", "二", "三", "四", "五", "六"];
      const dayStr = days.length ? days.map((d) => `周${names[d]}`).join(",") : "每周";
      return cfg.time ? `${dayStr} ${cfg.time}` : dayStr;
    }
    case "cron":
      return cfg.cron || a.schedule || "自定义周期";
    case "once":
      return cfg.datetime || a.runAt || "一次性";
    default:
      return a.schedule || "未知";
  }
}

export interface SchedulerHandlers {
  /** Runs an automation turn; should stream events and return when the turn ends.
   *  `model` is the optional model id chosen for this automation (empty = global default). */
  runAutomationTurn: (
    sessionId: string,
    instructions: string,
    onEvent: (e: unknown) => void,
    model?: string,
  ) => Promise<void>;
}

/**
 * Lightweight in-process scheduler. Ticks every 30s. Fires daily, weekly, cron
 * and one-shot automations. Each run gets its own session so transcripts live
 * in the chat history.
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
    logger.info("automation", "scheduler started", { intervalMs: 30_000 });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    logger.info("automation", "scheduler stopped");
  }

  async previewNext(a: Automation): Promise<Date | null> {
    const now = new Date();
    if (!isWithinValidity(a, now)) return null;
    const cfg = a.scheduleConfig || {};
    switch (a.scheduleType) {
      case "once": {
        const dt = cfg.datetime || a.runAt;
        return dt ? new Date(dt) : null;
      }
      case "cron": {
        const expr = cfg.cron || a.schedule;
        return expr ? nextCronFire(expr, now) : null;
      }
      case "daily": {
        const t = parseTime(cfg.time);
        if (!t) return null;
        const d = new Date(now);
        d.setHours(t.hour, t.minute, 0, 0);
        if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
        return d;
      }
      case "weekly": {
        const t = parseTime(cfg.time);
        const days = cfg.days ?? [];
        if (!t || !days.length) return null;
        const d = new Date(now);
        d.setHours(t.hour, t.minute, 0, 0);
        for (let i = 0; i < 14; i++) {
          if (d.getTime() > now.getTime() && days.includes(d.getDay())) return new Date(d);
          d.setDate(d.getDate() + 1);
        }
        return null;
      }
      default:
        return null;
    }
  }

  private async catchUpOnce(): Promise<void> {
    const due = listDueAutomations(Date.now());
    for (const a of due) {
      await this.fire(a);
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
      if (!isWithinValidity(a, now)) continue;
      if (this.lastFire.get(a.id) === minute) continue;
      if (shouldFire(a, now)) {
        this.lastFire.set(a.id, minute);
        await this.fire(a);
        if (a.scheduleType === "once") {
          updateAutomation(a.id, { enabled: false });
        }
      }
    }
  }

  private async fire(a: Automation): Promise<void> {
    if (!this.handlers) return;
    // Re-read automation so edits/disables are respected immediately.
    const fresh = getAutomation(a.id);
    if (!fresh || !fresh.enabled) return;
    a = fresh;
    this.running.add(a.id);
    const session = createSession(`⏰ ${a.title}`, a.workspaceDir, a.model);
    const run = startRun(a.id, session.id);
    this.emit("run:started", { automation: a, run });
    logger.info("automation", "run started", {
      automationId: a.id,
      title: a.title,
      scheduleType: a.scheduleType,
      schedule: describeSchedule(a),
      model: a.model ?? "(default)",
      sessionId: session.id,
      runId: run.id,
    });
    try {
      await this.handlers.runAutomationTurn(
        session.id,
        a.instructions,
        (event) => this.emit("run:event", { automationId: a.id, sessionId: session.id, event }),
        a.model,
      );
      finishRun(run.id, "success");
      markAutomationRun(a.id, "success", Date.now());
      this.emit("run:finished", { automation: a, run, sessionId: session.id });
      logger.info("automation", "run finished", {
        automationId: a.id,
        title: a.title,
        sessionId: session.id,
        runId: run.id,
        status: "success",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finishRun(run.id, "error", message);
      markAutomationRun(a.id, "error", Date.now());
      this.emit("run:error", { automation: a, run, error: message, sessionId: session.id });
      logger.error("automation", "run failed", {
        automationId: a.id,
        title: a.title,
        sessionId: session.id,
        runId: run.id,
        error: message,
      });
    } finally {
      this.running.delete(a.id);
    }
  }

  /** Manually trigger an automation now. */
  async runNow(a: Automation): Promise<void> {
    if (this.running.has(a.id)) return;
    logger.info("automation", "runNow triggered", { automationId: a.id, title: a.title });
    await this.fire(a);
  }
}

export const scheduler = new AutomationScheduler();
