import { EventEmitter } from "node:events";
import { createSession } from "../storage/sessions";
import {
  listAutomations,
  listDueAutomations,
  markAutomationRun,
  recordAutomationOutcome,
  startRun,
  finishRun,
  updateAutomation,
  getAutomation,
  setLastFiredSlot,
  getLastFiredSlot,
} from "../storage/automations";
import type { Automation, AutomationRun, AutomationScheduleConfig, PermissionMode } from "../../shared/types";
import { logger } from "../log/logger";
import { loadSettings } from "../storage/settings";
import { DEFAULT_WORKSPACE_DIR } from "../config/paths";
import { wallClockParts, zonedWallToEpoch, zonedDateTimeToEpoch, systemTimeZone } from "./timezone";

/** Effective schedule timezone: stored IANA zone, else system local. */
function tzOf(a: Automation): string | undefined {
  return a.scheduleConfig?.timezone || systemTimeZone();
}

// Minimal cron matcher: supports "*", step (every N), lists "a,b,c", ranges "a-b".
function fieldMatches(pattern: string, value: number, min: number, max: number): boolean {
  for (const part of pattern.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    let range = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (!Number.isFinite(step) || step < 1) return false;
    let lo = min;
    let hi = max;
    if (range !== "*") {
      if (range.includes("-")) {
        const [a, b] = range.split("-").map(Number);
        if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return false;
        lo = a;
        hi = b;
      } else {
        const n = Number(range);
        if (Number.isNaN(n)) return false;
        lo = hi = n;
      }
    }
    // Out-of-range bounds/values must not silently match (L-5).
    if (lo < min || hi > max) return false;
    for (let v = lo; v <= hi; v += step) {
      if (v === value) return true;
    }
  }
  return false;
}

/** Whether a field pattern is the unrestricted "*" wildcard. */
function isStar(p: string): boolean {
  return p === "*";
}

export function cronMatches(expr: string, d: Date, timeZone?: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const w = wallClockParts(d.getTime(), timeZone);
  const min = fieldMatches(parts[0], w.minute, 0, 59);
  const hour = fieldMatches(parts[1], w.hour, 0, 23);
  const month = fieldMatches(parts[3], w.month1, 1, 12);
  // Standard cron semantics: if BOTH day-of-month and day-of-week are
  // restricted (not "*"), they are OR'd (either satisfying triggers); if
  // either is "*", they are AND'd with the rest. L-4.
  const dom = fieldMatches(parts[2], w.day, 1, 31);
  const dow = fieldMatches(parts[4], w.dow, 0, 6);
  const domStar = isStar(parts[2]);
  const dowStar = isStar(parts[4]);
  const dayOk =
    (!domStar && !dowStar) ? dom || dow : dom && dow;
  return min && hour && month && dayOk;
}

/** Next fire time for a cron expression (minute granularity). */
export function nextCronFire(expr: string, from: Date, timeZone?: string): Date | null {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (cronMatches(expr, d, timeZone)) return new Date(d);
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

export function parseTime(time?: string): { hour: number; minute: number } | null {
  if (!time) return null;
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return { hour: h, minute: m };
}

export function isWithinValidity(a: Automation, now: Date): boolean {
  const tz = tzOf(a);
  if (a.validFrom) {
    const from = zonedDateTimeToEpoch(a.validFrom, "00:00", false, tz);
    if (from !== null && now.getTime() < from) return false;
  }
  if (a.validUntil) {
    const until = zonedDateTimeToEpoch(a.validUntil, "23:59", true, tz);
    if (until !== null && now.getTime() > until) return false;
  }
  return true;
}

export function shouldFire(a: Automation, now: Date): boolean {
  const cfg = a.scheduleConfig || {};
  const type = a.scheduleType || "daily";
  const tz = tzOf(a);
  if (type === "once") {
    const dt = cfg.datetime;
    return !!dt && new Date(dt).getTime() <= now.getTime();
  }
  if (type === "daily") {
    const t = parseTime(cfg.time);
    if (!t) return false;
    const w = wallClockParts(now.getTime(), tz);
    return w.hour === t.hour && w.minute === t.minute;
  }
  if (type === "weekly") {
    const t = parseTime(cfg.time);
    if (!t) return false;
    const days = cfg.days ?? [];
    const w = wallClockParts(now.getTime(), tz);
    if (!days.includes(w.dow)) return false;
    return w.hour === t.hour && w.minute === t.minute;
  }
  if (type === "cron") {
    const expr = cfg.cron;
    return !!expr && cronMatches(expr, now, tz);
  }
  return false;
}

/** How late a scheduled run may still fire after its instant (missed-tick catch-up). */
export const FIRE_GRACE_MS = 5 * 60_000;

/**
 * The scheduled instant this automation is currently due for, or null.
 *
 * Unlike `shouldFire` (exact minute match) this returns the *planned* instant
 * and tolerates a grace window, so a tick that arrives late — because a long
 * automation held the loop, or the machine was busy — still fires instead of
 * silently skipping the slot (H-S2). The returned instant doubles as the
 * dedupe key: one run per planned slot, no matter how many ticks see it.
 */
export function dueInstant(
  a: Automation,
  now: Date,
  graceMs: number = FIRE_GRACE_MS,
): number | null {
  const cfg: AutomationScheduleConfig = a.scheduleConfig || {};
  const type = a.scheduleType || "daily";
  const tz = tzOf(a);
  if (type === "once") {
    const dt = cfg.datetime;
    if (!dt) return null;
    const t = new Date(dt).getTime();
    // One-shots are never dropped: they fire whenever we first see them due.
    return Number.isFinite(t) && t <= now.getTime() ? t : null;
  }
  if (type === "daily" || type === "weekly") {
    const t = parseTime(cfg.time);
    if (!t) return null;
    // Build today's scheduled instant in the automation's timezone.
    const w = wallClockParts(now.getTime(), tz);
    const sched = zonedWallToEpoch(
      w.year, w.month1, w.day, t.hour, t.minute, 0, 0, tz,
    );
    if (!Number.isFinite(sched)) return null;
    if (type === "weekly" && !(cfg.days ?? []).includes(w.dow)) return null;
    const delta = now.getTime() - sched;
    return delta >= 0 && delta <= graceMs ? sched : null;
  }
  if (type === "cron") {
    const expr = cfg.cron;
    if (!expr) return null;
    // Walk back minute by minute within the grace window, testing each instant
    // against the cron in the automation's timezone.
    const steps = Math.floor(graceMs / 60_000);
    const base = new Date(now);
    base.setSeconds(0, 0);
    for (let i = 0; i <= steps; i++) {
      const probe = new Date(base.getTime() - i * 60_000);
      if (cronMatches(expr, probe, tz)) return probe.getTime();
    }
    return null;
  }
  return null;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function describeSchedule(a: Automation): string {
  const cfg = a.scheduleConfig || {};
  switch (a.scheduleType) {
    case "daily":
      return cfg.time ? `Daily ${cfg.time}` : "Daily";
    case "weekly": {
      const days = cfg.days ?? [];
      const dayStr = days.length
        ? days.map((d) => WEEKDAY_NAMES[d]).join(",")
        : "Weekly";
      return cfg.time ? `${dayStr} ${cfg.time}` : dayStr;
    }
    case "cron":
      return cfg.cron || "custom schedule";
    case "once":
      return cfg.datetime || "one-shot";
    default:
      return "unknown";
  }
}

export interface SchedulerHandlers {
  /** Runs an automation turn; should stream events and return when the turn ends.
   *  `model` is the optional model id chosen for this automation (empty = global default).
   *  `mode` is the optional permission mode (empty = global default). */
  runAutomationTurn: (
    sessionId: string,
    instructions: string,
    onEvent: (e: unknown) => void,
    model?: string,
    mode?: PermissionMode,
  ) => Promise<void>;
}

/**
 * Lightweight in-process scheduler. Ticks every 30s. Fires daily, weekly, cron
 * and one-shot automations. Each run gets its own session so transcripts live
 * in the chat history.
 */
export class AutomationScheduler extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private handlers: SchedulerHandlers | null = null;
  /** automationId -> the scheduled instant (epoch ms) already fired for */
  private lastFire = new Map<string, number>();
  private running = new Set<string>();
  /** Guards against overlapping ticks when one outlives the 30s interval. */
  private ticking = false;

  /** One retry absorbs transient model/network failures without creating a loop. */
  private static readonly MAX_RUN_ATTEMPTS = 2;

  init(handlers: SchedulerHandlers): void {
    this.handlers = handlers;
  }

  start(): void {
    if (this.timer) return;
    // Catch up any one-shots that came due while the app was closed. This goes
    // through the same running/dedup gate as a normal tick (M-storage②).
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
    const tz = tzOf(a);
    switch (a.scheduleType) {
      case "once": {
        const dt = cfg.datetime;
        return dt ? new Date(dt) : null;
      }
      case "cron": {
        const expr = cfg.cron;
        return expr ? nextCronFire(expr, now, tz) : null;
      }
      case "daily":
      case "weekly": {
        const t = parseTime(cfg.time);
        if (!t) return null;
        const days = a.scheduleType === "weekly" ? (cfg.days ?? []) : null;
        if (days && !days.length) return null;
        // Walk forward day by day in the target timezone.
        const startW = wallClockParts(now.getTime(), tz);
        for (let i = 0; i < 14; i++) {
          const epoch = zonedWallToEpoch(
            startW.year, startW.month1, startW.day + i, t.hour, t.minute, 0, 0, tz,
          );
          if (!Number.isFinite(epoch)) continue;
          if (epoch <= now.getTime()) continue;
          if (days) {
            const w = wallClockParts(epoch, tz);
            if (!days.includes(w.dow)) continue;
          }
          return new Date(epoch);
        }
        return null;
      }
      default:
        return null;
    }
  }

  private async catchUpOnce(): Promise<void> {
    const due = listDueAutomations(Date.now());
    // Process missed one-shots sequentially: if the app was closed for a long
    // stretch many could be due at once, and launching them all concurrently
    // would stampede sessions/models (M-storage②). Each is still fire-and-forget
    // relative to the scheduler loop but bounded to one-at-a-time here.
    for (const a of due) {
      if (this.running.has(a.id)) continue;
      try {
        await this.launch(a);
      } catch {
        // launch() never rejects; guard against future regressions.
      }
    }
  }

  /**
   * Start a run without blocking the caller and disable one-shots afterwards.
   * `fire` never rejects (it catches internally), but keep a guard anyway so a
   * future refactor can't turn this into an unhandled rejection.
   */
  private launch(a: Automation): Promise<void> {
    return this.fire(a)
      .catch(() => undefined)
      .then(() => {
        if (a.scheduleType === "once") {
          try {
            updateAutomation(a.id, { enabled: false });
          } catch {
            /* storage error already logged elsewhere */
          }
        }
      });
  }

  private async tick(): Promise<void> {
    // Ticks are 30s apart but a tick can outlive its interval; overlapping
    // runs would double-read the table and race on lastFire (H-S2).
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date();
      let automations: Automation[];
      try {
        automations = listAutomations();
      } catch {
        return;
      }
      for (const a of automations) {
        if (!a.enabled || this.running.has(a.id)) continue;
        if (!isWithinValidity(a, now)) continue;
        const due = dueInstant(a, now);
        if (due === null) continue;
        // Seed the in-memory dedupe from the persisted slot so a restart
        // inside the grace window doesn't re-fire the same recurring slot
        // (M-storage②).
        if (!this.lastFire.has(a.id)) {
          const persisted = getLastFiredSlot(a.id);
          if (persisted != null) this.lastFire.set(a.id, persisted);
        }
        if (this.lastFire.get(a.id) === due) continue;
        this.lastFire.set(a.id, due);
        try {
          setLastFiredSlot(a.id, due);
        } catch (err) {
          logger.error("automation", "failed to persist lastFiredSlot", {
            automationId: a.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // Fire-and-forget: a long-running automation must not stall the loop
        // and make every other schedule miss its slot (H-S2).
        void this.launch(a);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async fire(a: Automation): Promise<void> {
    if (!this.handlers) return;
    // Re-read automation so edits/disables are respected immediately.
    const fresh = getAutomation(a.id);
    if (!fresh || !fresh.enabled) return;
    a = fresh;
    this.running.add(a.id);
    const settings = loadSettings();
    const session = createSession(
      `⏰ ${a.title}`,
      a.workspaceDir,
      a.model,
      "automation",
      settings.model.workspaceDir || DEFAULT_WORKSPACE_DIR,
      a.permissionMode ?? settings.permissionMode,
    );
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
      let lastError: unknown;
      for (let attempt = 1; attempt <= AutomationScheduler.MAX_RUN_ATTEMPTS; attempt++) {
        try {
          await this.handlers.runAutomationTurn(
            session.id,
            a.instructions,
            (event) => this.emit("run:event", { automationId: a.id, sessionId: session.id, event }),
            a.model,
            a.permissionMode,
          );
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err;
          if (attempt < AutomationScheduler.MAX_RUN_ATTEMPTS) {
            logger.warn("automation", "run retry", { automationId: a.id, runId: run.id, attempt });
          }
        }
      }
      if (lastError) throw lastError;
      finishRun(run.id, "success");
      markAutomationRun(a.id, "success", Date.now());
      recordAutomationOutcome(a.id, "success");
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
      const outcome = recordAutomationOutcome(a.id, "error");
      this.emit("run:error", { automation: a, run, error: message, sessionId: session.id });
      logger.error("automation", "run failed", {
        automationId: a.id,
        title: a.title,
        sessionId: session.id,
        runId: run.id,
        error: message,
        consecutiveFailures: outcome.consecutiveFailures,
        autoPaused: outcome.autoPaused,
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
