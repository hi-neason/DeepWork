/**
 * Timezone-aware wall-clock helpers for the scheduler.
 *
 * Daily/weekly/cron schedules describe a *wall clock* ("every day at 09:00")
 * that must stay anchored to the timezone the automation was created in, even
 * if the machine travels or its system timezone changes (M-storage①). When no
 * explicit IANA timezone is stored we fall back to the system local time, which
 * preserves the behaviour of automations created before this field existed.
 */

export interface WallClockParts {
  /** 4-digit year. */
  year: number;
  /** Month, 1-12. */
  month1: number;
  /** Day of month, 1-31. */
  day: number;
  hour: number;
  minute: number;
  /** Day of week, 0 = Sunday … 6 = Saturday. */
  dow: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function makeFormatter(timeZone?: string): Intl.DateTimeFormat {
  const key = timeZone ?? "__local__";
  let fmt = formatterCache.get(key);
  if (fmt) return fmt;
  const opts: Intl.DateTimeFormatOptions = {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  };
  if (timeZone) opts.timeZone = timeZone;
  fmt = new Intl.DateTimeFormat("en-US", opts);
  formatterCache.set(key, fmt);
  return fmt;
}

/**
 * Wall-clock parts for an instant in the given IANA timezone.
 * Pass `undefined`/empty to use the system local timezone.
 */
export function wallClockParts(epochMs: number, timeZone?: string): WallClockParts {
  const d = new Date(epochMs);
  if (!timeZone) {
    return {
      year: d.getFullYear(),
      month1: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      dow: d.getDay(),
    };
  }
  const parts = makeFormatter(timeZone).formatToParts(d);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month1: Number(get("month")),
    day: Number(get("day")),
    // hour12:false still yields "24" for midnight in some ICU builds.
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    dow: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/**
 * Convert a wall-clock date+time in `timeZone` back to an epoch ms.
 * Pass `undefined`/empty to interpret in the system local timezone.
 */
export function zonedWallToEpoch(
  year: number,
  month1: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone?: string,
): number {
  if (!timeZone) {
    return new Date(year, month1 - 1, day, hour, minute, second, ms).getTime();
  }
  // Two-pass technique: pretend the wall clock is UTC, read what that instant
  // actually looks like in the target zone, then subtract the discrepancy.
  const asUTC = Date.UTC(year, month1 - 1, day, hour, minute, second, ms);
  const actual = wallClockParts(asUTC, timeZone);
  const asUTC2 = Date.UTC(
    actual.year,
    actual.month1 - 1,
    actual.day,
    actual.hour,
    actual.minute,
    second,
    ms,
  );
  return asUTC - (asUTC2 - asUTC);
}

/** Parse "YYYY-MM-DD" + "HH:MM" in the given zone into an epoch ms. */
export function zonedDateTimeToEpoch(
  dateStr: string | undefined,
  timeStr: string | undefined,
  atEndOfDay: boolean,
  timeZone?: string,
): number | null {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const year = Number(m[1]);
  const month1 = Number(m[2]);
  const day = Number(m[3]);
  let hour = 0;
  let minute = 0;
  if (timeStr) {
    const tm = /^(\d{1,2}):(\d{2})$/.exec(timeStr);
    if (tm) {
      hour = Number(tm[1]);
      minute = Number(tm[2]);
    }
  }
  return zonedWallToEpoch(
    year,
    month1,
    day,
    atEndOfDay ? 23 : hour,
    atEndOfDay ? 59 : minute,
    atEndOfDay ? 59 : 0,
    atEndOfDay ? 999 : 0,
    timeZone,
  );
}

/**
 * Detect the system's IANA timezone, or undefined if Intl is unavailable
 * (callers treat undefined as "system local").
 */
export function systemTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
