import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Automation } from "../../shared/types";

// 纯逻辑部分：直接测导出的 cron/validity 判定。
// 集成部分：用 vi.mock 替换 storage 层，驱动真实 tick/fire 流程。
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

function auto(partial: Partial<Automation>): Automation {
  return {
    id: "a1",
    title: "t",
    instructions: "do",
    schedule: "",
    enabled: true,
    createdAt: 0,
    ...partial,
  } as Automation;
}

describe("automation/scheduler — 纯逻辑", () => {
  it("cronMatches: 5 段匹配，段数不对返回 false", () => {
    const d = new Date(2026, 7, 10, 9, 30, 0); // 周一 9:30
    expect(cronMatches("30 9 10 8 1", d)).toBe(true);
    expect(cronMatches("31 9 10 8 1", d)).toBe(false);
    expect(cronMatches("* * * * *", d)).toBe(true);
    expect(cronMatches("*/15 * * * *", d)).toBe(true); // 30 在 0,15,30,45
    expect(cronMatches("0 9 * * 1", d)).toBe(false); // 分钟 0 != 30
    expect(cronMatches("bad", d)).toBe(false);
  });

  it("cronMatches: 列表与范围", () => {
    const d = new Date(2026, 7, 10, 9, 0, 0);
    expect(cronMatches("0 9 * 8 1,3,5", d)).toBe(true); // 周一命中列表
    expect(cronMatches("0 9 * 8 2", d)).toBe(false); // 周二不在列表
    expect(cronMatches("0 9-10 * 8 1", d)).toBe(true); // 小时范围 9-10
    expect(cronMatches("0 11 * 8 1", d)).toBe(false);
  });

  it("parseTime", () => {
    expect(parseTime("09:30")).toEqual({ hour: 9, minute: 30 });
    expect(parseTime("9:5")).toEqual({ hour: 9, minute: 5 });
    expect(parseTime(undefined)).toBeNull();
    expect(parseTime("nope")).toBeNull();
  });

  it("isWithinValidity: validFrom/validUntil 边界（含当天）", () => {
    const now = new Date(2026, 7, 15, 12, 0, 0);
    expect(isWithinValidity(auto({ validFrom: "2026-08-10", validUntil: "2026-08-20" }), now)).toBe(true);
    expect(isWithinValidity(auto({ validFrom: "2026-08-16" }), now)).toBe(false); // 还没到
    expect(isWithinValidity(auto({ validUntil: "2026-08-14" }), now)).toBe(false); // 已过期
    expect(isWithinValidity(auto({}), now)).toBe(true);
  });

  it("shouldFire: daily / weekly / cron / once", () => {
    const mon = new Date(2026, 7, 10, 9, 30, 0); // 周一
    expect(shouldFire(auto({ scheduleType: "daily", scheduleConfig: { time: "09:30" } }), mon)).toBe(true);
    expect(shouldFire(auto({ scheduleType: "daily", scheduleConfig: { time: "09:31" } }), mon)).toBe(false);
    expect(shouldFire(auto({ scheduleType: "weekly", scheduleConfig: { time: "09:30", days: [1] } }), mon)).toBe(true);
    expect(shouldFire(auto({ scheduleType: "weekly", scheduleConfig: { time: "09:30", days: [2] } }), mon)).toBe(false);
    expect(shouldFire(auto({ scheduleType: "cron", scheduleConfig: { cron: "30 9 * * 1" } }), mon)).toBe(true);
    expect(shouldFire(auto({ scheduleType: "once", scheduleConfig: { datetime: "2026-08-10T09:30:00" } }), mon)).toBe(true);
    expect(shouldFire(auto({ scheduleType: "once", scheduleConfig: { datetime: "2026-08-11T09:30:00" } }), mon)).toBe(false);
  });
});

describe("automation/scheduler — tick/fire 集成（mock storage）", () => {
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

  it("到期自动化在 tick 中被触发一次", async () => {
    const a = auto({ scheduleType: "cron", scheduleConfig: { cron: "* * * * *" } });
    vi.mocked(automations.listAutomations).mockReturnValue([a]);
    vi.mocked(automations.getAutomation).mockReturnValue(a);
    await (s as any).tick();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(automations.startRun).toHaveBeenCalled();
    expect(automations.finishRun).toHaveBeenCalledWith("run-1", "success");
  });

  it("未到期自动化不被触发", async () => {
    const a = auto({ scheduleType: "daily", scheduleConfig: { time: "03:33" } });
    vi.mocked(automations.listAutomations).mockReturnValue([a]);
    vi.mocked(automations.getAutomation).mockReturnValue(a);
    await (s as any).tick();
    expect(handler).not.toHaveBeenCalled();
  });

  it("同一分钟内重复 tick 去重（lastFire 命中即跳过），不重复触发", async () => {
    const a = auto({ scheduleType: "cron", scheduleConfig: { cron: "* * * * *" } });
    vi.mocked(automations.listAutomations).mockReturnValue([a]);
    vi.mocked(automations.getAutomation).mockReturnValue(a);
    await (s as any).tick();
    await (s as any).tick();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("running 集合防止并发重入", async () => {
    const a = auto({ scheduleType: "cron", scheduleConfig: { cron: "* * * * *" } });
    // 第一次 fire 未结束前，running 含 a.id
    let resolveFire: () => void;
    const gate = new Promise<void>((res) => (resolveFire = res));
    handler.mockImplementation(async () => {
      await gate;
    });
    vi.mocked(automations.listAutomations)
      .mockReturnValueOnce([a])
      .mockReturnValueOnce([a]);
    vi.mocked(automations.getAutomation).mockReturnValue(a);
    const p1 = (s as any).tick(); // 进入 fire 后挂起在 gate
    const p2 = (s as any).tick(); // 同步部分应看到 running，跳过
    await new Promise((r) => setTimeout(r, 0)); // 让 p2 的同步逻辑跑完
    expect(handler).toHaveBeenCalledTimes(1); // p2 因 running 含 a.id 而跳过
    resolveFire!();
    await p1;
    await p2;
  });

  it("重启后从持久化的 lastFiredSlot 恢复，宽限期内不重复触发同一槽位", async () => {
    const a = auto({ scheduleType: "cron", scheduleConfig: { cron: "* * * * *" } });
    vi.mocked(automations.listAutomations).mockReturnValue([a]);
    vi.mocked(automations.getAutomation).mockReturnValue(a);
    // 模拟重启：该槽位已在上一进程触发并持久化
    vi.mocked(automations.getLastFiredSlot).mockImplementation(() => dueInstant(a, new Date()));
    await (s as any).tick();
    expect(handler).not.toHaveBeenCalled();
  });
});
