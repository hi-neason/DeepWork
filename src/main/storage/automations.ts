import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import type { Automation, AutomationRun, AutomationStatus } from "../../shared/types";

interface AutoRow {
  id: string;
  title: string;
  instructions: string;
  schedule: string;
  run_at: string | null;
  enabled: number;
  created_at: number;
  last_run_at: number | null;
  last_status: string | null;
}

interface RunRow {
  id: string;
  automation_id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  error: string | null;
  session_id: string | null;
}

function rowToAutomation(r: AutoRow): Automation {
  return {
    id: r.id,
    title: r.title,
    instructions: r.instructions,
    schedule: r.schedule,
    runAt: r.run_at ?? undefined,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    lastRunAt: r.last_run_at ?? undefined,
    lastStatus: (r.last_status as AutomationStatus) ?? undefined,
  };
}

function rowToRun(r: RunRow): AutomationRun {
  return {
    id: r.id,
    automationId: r.automation_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? undefined,
    status: r.status as AutomationStatus,
    error: r.error ?? undefined,
    sessionId: r.session_id ?? undefined,
  };
}

export function listAutomations(): Automation[] {
  const rows = getDb()
    .prepare(`SELECT * FROM automations ORDER BY created_at DESC`)
    .all() as AutoRow[];
  return rows.map(rowToAutomation);
}

export function createAutomation(a: Omit<Automation, "id" | "createdAt" | "enabled">): Automation {
  const row: AutoRow = {
    id: randomUUID(),
    title: a.title,
    instructions: a.instructions,
    schedule: a.schedule,
    run_at: a.runAt ?? null,
    enabled: 1,
    created_at: Date.now(),
    last_run_at: null,
    last_status: null,
  };
  getDb()
    .prepare(
      `INSERT INTO automations (id, title, instructions, schedule, run_at, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.title, row.instructions, row.schedule, row.run_at, row.enabled, row.created_at);
  return rowToAutomation(row);
}

export function updateAutomation(id: string, patch: Partial<Automation>): void {
  const existing = getDb()
    .prepare(`SELECT * FROM automations WHERE id = ?`)
    .get(id) as AutoRow | undefined;
  if (!existing) return;
  const next = { ...existing, ...patch };
  getDb()
    .prepare(
      `UPDATE automations SET title=?, instructions=?, schedule=?, run_at=?, enabled=? WHERE id=?`,
    )
    .run(
      next.title,
      next.instructions,
      next.schedule,
      next.runAt ?? null,
      next.enabled ? 1 : 0,
      id,
    );
}

export function deleteAutomation(id: string): void {
  getDb().prepare(`DELETE FROM automations WHERE id = ?`).run(id);
  getDb().prepare(`DELETE FROM automation_runs WHERE automation_id = ?`).run(id);
}

export function markAutomationRun(
  id: string,
  status: AutomationStatus,
  runAt: number | null,
): void {
  getDb()
    .prepare(
      `UPDATE automations SET last_run_at = ?, last_status = ? WHERE id = ?`,
    )
    .run(runAt, status, id);
}

// ---- runs ----

export function startRun(automationId: string, sessionId: string): AutomationRun {
  const row: RunRow = {
    id: randomUUID(),
    automation_id: automationId,
    started_at: Date.now(),
    finished_at: null,
    status: "running",
    error: null,
    session_id: sessionId,
  };
  getDb()
    .prepare(
      `INSERT INTO automation_runs (id, automation_id, started_at, status, session_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.automation_id, row.started_at, row.status, row.session_id);
  return rowToRun(row);
}

export function finishRun(
  id: string,
  status: AutomationStatus,
  error?: string,
): void {
  getDb()
    .prepare(
      `UPDATE automation_runs SET finished_at = ?, status = ?, error = ? WHERE id = ?`,
    )
    .run(Date.now(), status, error ?? null, id);
}

export function listRuns(automationId: string, limit = 20): AutomationRun[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?`,
    )
    .all(automationId, limit) as RunRow[];
  return rows.map(rowToRun);
}

export function listDueAutomations(now: number): Automation[] {
  // For "once" tasks that are enabled and past their run_at. Cron due-calculation
  // happens in the scheduler (which tracks last fire minute). We return enabled
  // one-shots here; cron ones are handled via in-memory ticking.
  const rows = getDb()
    .prepare(
      `SELECT * FROM automations WHERE enabled = 1 AND schedule = 'once' AND run_at IS NOT NULL`,
    )
    .all() as AutoRow[];
  return rows
    .map(rowToAutomation)
    .filter((a) => a.runAt && new Date(a.runAt).getTime() <= now);
}
