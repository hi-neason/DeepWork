import { describe, it, expect } from "vitest";
import { wallClockParts, zonedWallToEpoch, zonedDateTimeToEpoch } from "./timezone";

describe("automation/timezone", () => {
  it("converts Shanghai wall-clock time 2026-08-10 09:30 to UTC 01:30", () => {
    const t = zonedWallToEpoch(2026, 8, 10, 9, 30, 0, 0, "Asia/Shanghai");
    expect(new Date(t).toISOString()).toBe("2026-08-10T01:30:00.000Z");
  });

  it("wallClockParts makes a round trip", () => {
    const t = zonedWallToEpoch(2026, 8, 10, 9, 30, 0, 0, "Asia/Shanghai");
    const w = wallClockParts(t, "Asia/Shanghai");
    expect(w).toMatchObject({ year: 2026, month1: 8, day: 10, hour: 9, minute: 30, dow: 1 });
  });

  it("handles daylight saving: New York is UTC-4 in summer and UTC-5 in winter", () => {
    const summer = zonedWallToEpoch(2026, 7, 10, 9, 30, 0, 0, "America/New_York");
    expect(new Date(summer).toISOString()).toBe("2026-07-10T13:30:00.000Z");
    const winter = zonedWallToEpoch(2026, 1, 10, 9, 30, 0, 0, "America/New_York");
    expect(new Date(winter).toISOString()).toBe("2026-01-10T14:30:00.000Z");
  });

  it("zonedDateTimeToEpoch parses YYYY-MM-DD + HH:MM", () => {
    const t = zonedDateTimeToEpoch("2026-08-10", "09:30", false, "Asia/Shanghai");
    expect(new Date(t!).toISOString()).toBe("2026-08-10T01:30:00.000Z");
  });

  it("atEndOfDay gives 23:59:59.999 of that day", () => {
    const t = zonedDateTimeToEpoch("2026-08-10", undefined, true, "Asia/Shanghai");
    expect(new Date(t!).toISOString()).toBe("2026-08-10T15:59:59.999Z");
  });

  it("falls back to the machine's local time when timezone is empty", () => {
    const local = zonedWallToEpoch(2026, 8, 10, 9, 30, 0, 0, undefined);
    expect(local).toBe(new Date(2026, 7, 10, 9, 30, 0, 0).getTime());
  });
});
