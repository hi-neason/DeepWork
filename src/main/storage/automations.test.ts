import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("better-sqlite3", () => import("../../test/mocks/better-sqlite3"));
vi.mock("../config/paths", () => ({ APP_DATA_DIR: "/tmp" }));
vi.mock("../log/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getDb } from "./db";
import type { AutomationScheduleConfig, ScheduleType } from "../../shared/types";
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  recordAutomationOutcome,
  updateAutomation,
} from "./automations";

const schedules: Array<[ScheduleType, AutomationScheduleConfig]> = [
  ["daily", { time: "09:00", timezone: "Asia/Shanghai" }],
  ["weekly", { time: "09:00", days: [1, 3, 5] }],
  ["cron", { cron: "0 9 * * 1-5" }],
  ["once", { datetime: "2026-08-20T09:00:00+08:00" }],
];

describe("automation storage", () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM automation_runs").run();
    getDb().prepare("DELETE FROM automations").run();
  });

  it.each(schedules)("round-trips a %s automation and all optional selectors", (scheduleType, scheduleConfig) => {
    const created = createAutomation({
      title: `${scheduleType} report`,
      instructions: "Summarize activity",
      enabled: false,
      scheduleType,
      scheduleConfig,
      workspaceDir: "/tmp/project",
      validFrom: "2026-08-01",
      validUntil: "2026-08-31",
      permissionMode: "auto-write",
      skills: ["release-notes"],
      mcpServerIds: ["github"],
      model: "openai:gpt-test",
    });

    expect(getAutomation(created.id)).toMatchObject({
      title: `${scheduleType} report`, enabled: false, scheduleType, scheduleConfig,
      workspaceDir: "/tmp/project", skills: ["release-notes"],
      mcpServerIds: ["github"], model: "openai:gpt-test",
      consecutiveFailures: 0, autoPaused: false,
    });
  });

  it("updates only supplied fields and ignores a missing automation", () => {
    const created = createAutomation({
      title: "Before", instructions: "Keep this", enabled: true,
      scheduleType: "daily", scheduleConfig: { time: "08:00" },
    });

    updateAutomation(created.id, { title: "After", enabled: false });
    expect(getAutomation(created.id)).toMatchObject({
      title: "After", instructions: "Keep this", enabled: false,
      scheduleConfig: { time: "08:00" },
    });
    expect(() => updateAutomation("missing", { title: "ignored" })).not.toThrow();
  });

  it("resets failure streak on success and auto-pauses at the threshold", () => {
    const created = createAutomation({
      title: "Fragile", instructions: "Run", enabled: true,
      scheduleType: "daily", scheduleConfig: { time: "08:00" },
    });

    expect(recordAutomationOutcome(created.id, "error")).toEqual({
      consecutiveFailures: 1, autoPaused: false,
    });
    expect(recordAutomationOutcome(created.id, "success")).toEqual({
      consecutiveFailures: 0, autoPaused: false,
    });
    recordAutomationOutcome(created.id, "error");
    recordAutomationOutcome(created.id, "error");
    expect(recordAutomationOutcome(created.id, "error")).toEqual({
      consecutiveFailures: 3, autoPaused: true,
    });
    expect(getAutomation(created.id)).toMatchObject({ enabled: false, autoPaused: true });
    expect(recordAutomationOutcome("missing", "error")).toEqual({
      consecutiveFailures: 0, autoPaused: false,
    });
  });

  it("deletes an automation together with its run history", () => {
    const created = createAutomation({
      title: "Delete", instructions: "Run", enabled: true,
      scheduleType: "daily", scheduleConfig: { time: "08:00" },
    });
    getDb().prepare(
      "INSERT INTO automation_runs (id, automation_id, started_at, status) VALUES (?, ?, ?, ?)",
    ).run("run-1", created.id, 1, "success");

    deleteAutomation(created.id);

    expect(getAutomation(created.id)).toBeNull();
    expect(getDb().prepare("SELECT * FROM automation_runs WHERE automation_id = ?")
      .all(created.id)).toEqual([]);
    expect(listAutomations()).toEqual([]);
  });
});
