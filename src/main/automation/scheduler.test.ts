import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Automation } from "../../shared/types";

// Pure-logic portion: directly test the exported cron/validity checks.
// Integration portion: use vi.mock to replace the storage layer and drive the
// real tick/fire flow.
vi.mock("../storage/automations", () => ({
  listAutomations: vi.fn(() => []),
  listDueAutomations: vi.fn(() => []),
  getAutomation: vi.fn(),
  updateAutomation: vi.fn(),
  markAutomationRun: vi.fn(),
  startRun: vi.fn(() => ({ id: "run-1" })),
  finishRun: vi.fn(),
  setLastFiredSlot: vi.fn(),
  getLastFiredSlot: vi.fn(() => null),
}));
vi.mock("../storage/sessions", () => ({
  createSession: vi.fn((title: string) => ({ id: "sess-" + title })),
}));
vi.mock("../log/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  cronMatches,
  parseTime,
  isWithinValidity,
  shouldFire,
  dueInstant,
  AutomationScheduler,
} from "./scheduler";
import * as automations from "../storage/automations";
import * as sessions from "../storage/sessions";

function auto(partial: Partial<Automation>): Automation {
  return {
    id: "a1",
    title: "t",
    instructions: "do",
    enabled: true,
    createdAt: 0,
    ...partial,
  } as Automation;
}

describe("automation/scheduler - pure logic", () => {
  it("cronMatches: matches 5 fields; wrong field count returns false", () => {
    const d = new Date(2026, 7, 10, 9, 30, 0); // Monday 9:30
    expect(cronMatches("30 9 10 8 1", d)).toBe(true);
    expect(cronMatches("31 9 10 8 1", d)).toBe(false);
    expect(cronMatches("* * * * *", d)).toBe(true);
    expect(cronMatches("*/15 * * * *", d)).toBe(true); // 30 is in 0,15,30,45
    expect(cronMatches("0 9 * * 1", d)).toBe(false); // minute 0 != 30
    expect(cronMatches("bad", d)).toBe(false);
  });

  it("cronMatches: lists and ranges", () => {
    const d = new Date(2026, 7, 10, 9, 0, 0);
    expect(cronMatches("0 9 * 8 1,3,5", d)).toBe(true); // Monday matches the list
    expect(cronMatches("0 9 * 8 2", d)).toBe(false); // Tuesday is not in the list
    expect(cronMatches("0 9-10 * 8 1", d)).toBe(true); // hour range 9-10
    expect(cronMatches("0 11 * 8 1", d)).toBe(false);
  });

  it("parseTime", () => {
    expect(parseTime("09:30")).toEqual({ hour: 9, minute: 30 });
    expect(parseTime("9:5")).toEqual({ hour: 9, minute: 5 });
    expect(parseTime(undefined)).toBeNull();
    expect(parseTime("nope")).toBeNull();
  });

  it("isWithinValidity: validFrom/validUntil boundaries (inclusive of the day)", () => {
    const now = new Date(2026, 7, 15, 12, 0, 0);
    expect(isWithinValidity(auto({ validFrom: "2026-08-10", validUntil: "2026-08-20" }), now)).toBe(true);
    expect(isWithinValidity(auto({ validFrom: "2026-08-16" }), now)).toBe(false); // not yet reached
    expect(isWithinValidity(auto({ validUntil: "2026-08-14" }), now)).toBe(false); // already expired
    expect(isWithinValidity(auto({}), now)).toBe(true);
  });

  it("shouldFire: daily / weekly / cron / once", () => {
    const mon = new Date(2026, 7, 10, 9, 30, 0); // Monday
    expect(shouldFire(auto({ scheduleType: "daily", scheduleConfig: { time: "09:30" } }), mon)).toBe(true);
    expect(shouldFire(auto({ scheduleType: "daily", scheduleConfig: { time: "09:31" } }), mon)).toBe(false);
    expect(shouldFire(auto({ scheduleType: "weekly", scheduleConfig: { time: "09:30", days: [1] } }), mon)).toBe(true);
    expect(shouldFire(auto({ scheduleType: "weekly", scheduleConfig: { time: "09:30", days: [2] } }), mon)).toBe(false);
    expect(shouldFire(auto({ scheduleType: "cron", scheduleConfig: { cron: "30 9 * * 1" } }), mon)).toBe(true);
    expect(shouldFire(auto({ scheduleType: "once", scheduleConfig: { datetime: "2026-08-10T09:30:00" } }), mon)).toBe(true);
    expect(shouldFire(auto({ scheduleType: "once", scheduleConfig: { datetime: "2026-08-11T09:30:00" } }), mon)).toBe(false);
  });
});

describe("automation/scheduler - tick/fire integration (mock storage)", () => {
  let s: AutomationScheduler;
  let handler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    s = new AutomationScheduler();
    handler = vi.fn(async () => {});
    s.init({ runAutomationTurn: handler as any });
    vi.clearAllMocks();
  });
  afterEach(() => {
    s.stop();
  });

  it("a due automation is triggered once during a tick", async () => {
    const a = auto({ scheduleType: "cron", scheduleConfig: { cron: "* * * * *" } });
    vi.mocked(automations.listAutomations).mockReturnValue([a]);
    vi.mocked(automations.getAutomation).mockReturnValue(a);
    await (s as any).tick();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(automations.startRun).toHaveBeenCalled();
    expect(automations.finishRun).toHaveBeenCalledWith("run-1", "success");
    // The run's transcript session is created as an automation source so it
    // stays out of the chat sidebar list.
    expect(sessions.createSession).toHaveBeenCalledWith(
      expect.stringContaining("t"),
      undefined,
      undefined,
      "automation",
    );
  });

  it("an automation that is not due is not triggered", async () => {
    const a = auto({ scheduleType: "daily", scheduleConfig: { time: "03:33" } });
    vi.mocked(automations.listAutomations).mockReturnValue([a]);
    vi.mocked(automations.getAutomation).mockReturnValue(a);
    await (s as any).tick();
    expect(handler).not.toHaveBeenCalled();
  });

  it("deduplicates repeated ticks within the same minute (skips when lastFire matches) without double-firing", async () => {
    const a = auto({ scheduleType: "cron", scheduleConfig: { cron: "* * * * *" } });
    vi.mocked(automations.listAutomations).mockReturnValue([a]);
    vi.mocked(automations.getAutomation).mockReturnValue(a);
    await (s as any).tick();
    await (s as any).tick();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("the running set prevents concurrent re-entry", async () => {
    const a = auto({ scheduleType: "cron", scheduleConfig: { cron: "* * * * *" } });
    // Before the first fire finishes, running contains a.id
    let resolveFire: () => void;
    const gate = new Promise<void>((res) => (resolveFire = res));
    handler.mockImplementation(async () => {
      await gate;
    });
    vi.mocked(automations.listAutomations)
      .mockReturnValueOnce([a])
      .mockReturnValueOnce([a]);
    vi.mocked(automations.getAutomation).mockReturnValue(a);
    const p1 = (s as any).tick(); // enters fire and then suspends at gate
    const p2 = (s as any).tick(); // its synchronous portion should see running and skip
    await new Promise((r) => setTimeout(r, 0)); // let p2's synchronous logic finish
    expect(handler).toHaveBeenCalledTimes(1); // p2 was skipped because running contains a.id
    resolveFire!();
    await p1;
    await p2;
  });

  it("after a restart it recovers from the persisted lastFiredSlot and does not re-fire the same slot within the grace period", async () => {
    const a = auto({ scheduleType: "cron", scheduleConfig: { cron: "* * * * *" } });
    vi.mocked(automations.listAutomations).mockReturnValue([a]);
    vi.mocked(automations.getAutomation).mockReturnValue(a);
    // Simulate a restart: this slot already fired and was persisted in the previous process
    vi.mocked(automations.getLastFiredSlot).mockImplementation(() => dueInstant(a, new Date()));
    await (s as any).tick();
    expect(handler).not.toHaveBeenCalled();
  });
});
