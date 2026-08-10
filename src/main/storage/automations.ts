import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import type {
  Automation,
  AutomationRun,
  AutomationScheduleConfig,
  AutomationStatus,
  AutomationWithRuns,
  ScheduleType,
} from "../../shared/types";

interface AutoRow {
  id: string;
  title: string;
  instructions: string;
  enabled: number;
  created_at: number;
  updated_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  workspace_dir: string | null;
  schedule_type: string | null;
  schedule_config: string | null;
  valid_from: string | null;
  valid_until: string | null;
  permission_mode: string | null;
  skills: string | null;
  mcp_server_ids: string | null;
  model: string | null;
  last_fired_slot: number | null;
  consecutive_failures: number | null;
  auto_paused: number | null;
}

function parseScheduleConfig(json: string | null): AutomationScheduleConfig | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as AutomationScheduleConfig;
  } catch {
    return undefined;
  }
}

function safeJsonArray(json: string | null): string[] | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function rowToAutomation(r: AutoRow): Automation {
  return {
    id: r.id,
    title: r.title,
    instructions: r.instructions,
    scheduleType: (r.schedule_type as ScheduleType) || "daily",
    scheduleConfig: parseScheduleConfig(r.schedule_config) || {},
    workspaceDir: r.workspace_dir ?? undefined,
    validFrom: r.valid_from ?? undefined,
    validUntil: r.valid_until ?? undefined,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? r.created_at,
    lastRunAt: r.last_run_at ?? undefined,
    lastStatus: (r.last_status as AutomationStatus) ?? undefined,
    consecutiveFailures: r.consecutive_failures ?? 0,
    autoPaused: r.auto_paused === 1,
    permissionMode: (r.permission_mode as Automation["permissionMode"]) ?? undefined,
    skills: safeJsonArray(r.skills),
    mcpServerIds: safeJsonArray(r.mcp_server_ids),
    model: r.model ?? undefined,
  };
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

export function getAutomation(id: string): Automation | null {
  const row = getDb()
    .prepare(`SELECT * FROM automations WHERE id = ?`)
    .get(id) as AutoRow | undefined;
  return row ? rowToAutomation(row) : null;
}

export function createAutomation(
  a: Omit<Automation, "id" | "createdAt" | "updatedAt">,
): Automation {
  const now = Date.now();
  const id = randomUUID();
  const scheduleType = a.scheduleType || "daily";
  const scheduleConfig = a.scheduleConfig || {};
  const row: AutoRow = {
    id,
    title: a.title,
    instructions: a.instructions,
    // Honor the caller's enabled flag so a paused automation can be created
    // paused (the renderer sends enabled:false when the toggle is off).
    enabled: a.enabled ? 1 : 0,
    created_at: now,
    updated_at: now,
    last_run_at: null,
    last_status: null,
    workspace_dir: a.workspaceDir ?? null,
    schedule_type: scheduleType,
    schedule_config: JSON.stringify(scheduleConfig),
    valid_from: a.validFrom ?? null,
    valid_until: a.validUntil ?? null,
    permission_mode: a.permissionMode ?? null,
    skills: a.skills ? JSON.stringify(a.skills) : null,
    mcp_server_ids: a.mcpServerIds ? JSON.stringify(a.mcpServerIds) : null,
    model: a.model ?? null,
    last_fired_slot: null,
    consecutive_failures: 0,
    auto_paused: 0,
  };
  getDb()
    .prepare(
      `INSERT INTO automations (
        id, title, instructions, enabled, created_at, updated_at,
        workspace_dir, schedule_type, schedule_config, valid_from, valid_until,
        permission_mode, skills, mcp_server_ids, model, last_fired_slot, consecutive_failures, auto_paused
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.title,
      row.instructions,
      row.enabled,
      row.created_at,
      row.updated_at,
      row.workspace_dir,
      row.schedule_type,
      row.schedule_config,
      row.valid_from,
      row.valid_until,
      row.permission_mode,
      row.skills,
      row.mcp_server_ids,
      row.model,
      row.last_fired_slot,
      row.consecutive_failures,
      row.auto_paused,
    );
  return rowToAutomation(row);
}

export function updateAutomation(id: string, patch: Partial<Automation>): void {
  const existing = getDb()
    .prepare(`SELECT * FROM automations WHERE id = ?`)
    .get(id) as AutoRow | undefined;
  if (!existing) return;
  const base = rowToAutomation(existing);
  const next: Automation = { ...base, ...patch, updatedAt: Date.now() };
  const scheduleType = next.scheduleType || base.scheduleType || "daily";
  const scheduleConfig = next.scheduleConfig || base.scheduleConfig || {};
  getDb()
    .prepare(
      `UPDATE automations SET
        title = ?, instructions = ?, enabled = ?, updated_at = ?,
        workspace_dir = ?, schedule_type = ?, schedule_config = ?, valid_from = ?, valid_until = ?,
        permission_mode = ?, skills = ?, mcp_server_ids = ?, model = ?
       WHERE id = ?`,
    )
    .run(
      next.title,
      next.instructions,
      next.enabled ? 1 : 0,
      next.updatedAt,
      next.workspaceDir ?? null,
      scheduleType,
      JSON.stringify(scheduleConfig),
      next.validFrom ?? null,
      next.validUntil ?? null,
      next.permissionMode ?? null,
      next.skills ? JSON.stringify(next.skills) : null,
      next.mcpServerIds ? JSON.stringify(next.mcpServerIds) : null,
      next.model ?? null,
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
      `UPDATE automations SET last_run_at = ?, last_status = ?, updated_at = ? WHERE id = ?`,
    )
    .run(runAt, status, Date.now(), id);
}

export const AUTOMATION_FAILURE_PAUSE_THRESHOLD = 3;

/** Record an outcome and disable an automation after repeated failures. */
export function recordAutomationOutcome(id: string, status: AutomationStatus): {
  consecutiveFailures: number;
  autoPaused: boolean;
} {
  const existing = getAutomation(id);
  if (!existing) return { consecutiveFailures: 0, autoPaused: false };
  const consecutiveFailures = status === "success" ? 0 : (existing.consecutiveFailures ?? 0) + 1;
  const autoPaused = status !== "success" && consecutiveFailures >= AUTOMATION_FAILURE_PAUSE_THRESHOLD;
  getDb()
    .prepare(
      `UPDATE automations SET consecutive_failures = ?, auto_paused = ?, enabled = ?, updated_at = ? WHERE id = ?`,
    )
    .run(consecutiveFailures, autoPaused ? 1 : 0, autoPaused ? 0 : (existing.enabled ? 1 : 0), Date.now(), id);
  return { consecutiveFailures, autoPaused };
}

/**
 * Persist the scheduled slot (epoch ms) that already fired for an automation,
 * so a scheduler restart inside the grace window cannot double-fire the same
 * recurring slot (M-storage②).
 */
export function setLastFiredSlot(id: string, slot: number): void {
  getDb()
    .prepare(`UPDATE automations SET last_fired_slot = ? WHERE id = ?`)
    .run(slot, id);
}

export function getLastFiredSlot(id: string): number | null {
  const row = getDb()
    .prepare(`SELECT last_fired_slot AS v FROM automations WHERE id = ?`)
    .get(id) as { v: number | null } | undefined;
  return row?.v ?? null;
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

export function listRuns(automationId: string, limit = 50): AutomationRun[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?`,
    )
    .all(automationId, limit) as RunRow[];
  return rows.map(rowToRun);
}

export function deleteRun(runId: string): void {
  getDb().prepare(`DELETE FROM automation_runs WHERE id = ?`).run(runId);
}

export function deleteRuns(automationId: string): void {
  getDb()
    .prepare(`DELETE FROM automation_runs WHERE automation_id = ?`)
    .run(automationId);
}

export function listAutomationsWithRuns(limitPerAutomation = 20): AutomationWithRuns[] {
  const automations = listAutomations();
  const runsMap = listRunsForAll(limitPerAutomation);
  return automations.map((a) => ({
    ...a,
    runs: runsMap.get(a.id) ?? [],
  }));
}

export function listRunsForAll(limitPerAutomation = 20): Map<string, AutomationRun[]> {
  const rows = getDb()
    .prepare(
      `SELECT * FROM automation_runs ORDER BY started_at DESC`,
    )
    .all() as RunRow[];
  const map = new Map<string, AutomationRun[]>();
  for (const r of rows) {
    const arr = map.get(r.automation_id) ?? [];
    if (arr.length < limitPerAutomation) {
      arr.push(rowToRun(r));
      map.set(r.automation_id, arr);
    }
  }
  return map;
}

/** Return enabled one-shot automations whose runAt has passed. */
export function listDueAutomations(now: number): Automation[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM automations WHERE enabled = 1 AND schedule_type = 'once'`,
    )
    .all() as AutoRow[];
  return rows
    .map(rowToAutomation)
    .filter((a) => {
      const dt = a.scheduleConfig?.datetime;
      return dt && new Date(dt).getTime() <= now;
    });
}
