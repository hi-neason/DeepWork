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
  schedule: string;
  run_at: string | null;
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

/** Migrate legacy schedule/run_at into scheduleType + scheduleConfig. */
function migrateLegacySchedule(a: Automation): Automation {
  if (a.scheduleType && a.scheduleType !== "cron") return a;
  if (a.scheduleConfig && Object.keys(a.scheduleConfig).length > 0) return a;
  if (a.runAt) {
    return {
      ...a,
      scheduleType: "once",
      scheduleConfig: { datetime: a.runAt },
    };
  }
  if (a.schedule && a.schedule !== "once") {
    return {
      ...a,
      scheduleType: "cron",
      scheduleConfig: { cron: a.schedule },
    };
  }
  return a;
}

function rowToAutomation(r: AutoRow): Automation {
  const scheduleType = (r.schedule_type as ScheduleType) || "cron";
  const scheduleConfig = parseScheduleConfig(r.schedule_config) || {};
  const a: Automation = {
    id: r.id,
    title: r.title,
    instructions: r.instructions,
    schedule: r.schedule,
    runAt: r.run_at ?? undefined,
    scheduleType,
    scheduleConfig,
    workspaceDir: r.workspace_dir ?? undefined,
    validFrom: r.valid_from ?? undefined,
    validUntil: r.valid_until ?? undefined,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? r.created_at,
    lastRunAt: r.last_run_at ?? undefined,
    lastStatus: (r.last_status as AutomationStatus) ?? undefined,
    permissionMode: (r.permission_mode as Automation["permissionMode"]) ?? undefined,
    skills: safeJsonArray(r.skills),
    mcpServerIds: safeJsonArray(r.mcp_server_ids),
    model: r.model ?? undefined,
  };
  return migrateLegacySchedule(a);
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

/** Best-effort migration of legacy rows. Called once at startup. */
export function migrateLegacyAutomations(): void {
  const rows = getDb()
    .prepare(
      `SELECT * FROM automations WHERE schedule_type IS NULL OR schedule_config IS NULL`,
    )
    .all() as AutoRow[];
  const update = getDb().prepare(
    `UPDATE automations SET schedule_type = ?, schedule_config = ?, updated_at = ? WHERE id = ?`,
  );
  for (const r of rows) {
    const a = rowToAutomation(r);
    update.run(
      a.scheduleType,
      JSON.stringify(a.scheduleConfig),
      Date.now(),
      r.id,
    );
  }
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
  a: Omit<Automation, "id" | "createdAt" | "updatedAt" | "enabled">,
): Automation {
  const now = Date.now();
  const id = randomUUID();
  const scheduleType = a.scheduleType || "daily";
  const scheduleConfig = a.scheduleConfig || {};
  const row: AutoRow = {
    id,
    title: a.title,
    instructions: a.instructions,
    schedule: a.schedule ?? (scheduleType === "cron" ? scheduleConfig.cron ?? "" : scheduleType),
    run_at: a.runAt ?? (scheduleType === "once" ? scheduleConfig.datetime ?? null : null),
    enabled: 1,
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
  };
  getDb()
    .prepare(
      `INSERT INTO automations (
        id, title, instructions, schedule, run_at, enabled, created_at, updated_at,
        workspace_dir, schedule_type, schedule_config, valid_from, valid_until,
        permission_mode, skills, mcp_server_ids, model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.title,
      row.instructions,
      row.schedule,
      row.run_at,
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
        title = ?, instructions = ?, schedule = ?, run_at = ?, enabled = ?, updated_at = ?,
        workspace_dir = ?, schedule_type = ?, schedule_config = ?, valid_from = ?, valid_until = ?,
        permission_mode = ?, skills = ?, mcp_server_ids = ?, model = ?
       WHERE id = ?`,
    )
    .run(
      next.title,
      next.instructions,
      next.schedule ?? (scheduleType === "cron" ? scheduleConfig.cron ?? "" : scheduleType),
      next.runAt ?? (scheduleType === "once" ? scheduleConfig.datetime ?? null : null),
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
      const dt = a.scheduleConfig?.datetime || a.runAt;
      return dt && new Date(dt).getTime() <= now;
    });
}
