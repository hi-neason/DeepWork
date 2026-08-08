import fs from "node:fs";
import path from "node:path";
import { TIMELINE_MEMORY_DIR } from "../config/paths";

const TZ = "Asia/Shanghai";

/** Today's date as YYYY-MM-DD in the app's timezone (Asia/Shanghai). */
export function todayStr(d: Date = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

/** Current time as HH:MM in the app's timezone. */
function timeStr(d: Date = new Date()): string {
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TZ,
  });
}

/** Absolute path of a given day's timeline file. */
export function timelineFilePath(dateStr: string): string {
  return path.join(TIMELINE_MEMORY_DIR, `${dateStr}.md`);
}

export interface TimelineEntry {
  /** ISO-ish day string; defaults to today. */
  date?: string;
  /** Project (workspace) name this conversation belonged to. */
  project: string;
  /** Session id the conversation happened in. */
  sessionId: string;
  /** Markdown bullet lines (each starting with "- ") distilled from the turn. */
  bullets: string;
}

/**
 * Append one conversation's distilled points to that day's timeline file.
 * The file is created with a `# <date> 时间线记忆` heading on first write.
 * Atomic write (tmp + rename) prevents corruption from concurrent turns.
 */
export function appendTimelineEntry(entry: TimelineEntry): void {
  const date = entry.date ?? todayStr();
  const file = timelineFilePath(date);
  fs.mkdirSync(TIMELINE_MEMORY_DIR, { recursive: true });

  let content = "";
  if (fs.existsSync(file)) {
    content = fs.readFileSync(file, "utf-8");
  } else {
    content = `# ${date} 时间线记忆\n`;
  }

  const header = `## ${timeStr()} · ${entry.project} · 会话${entry.sessionId.slice(0, 8)}`;
  const block = `${header}\n${entry.bullets.trim()}\n`;
  const updated = content.replace(/\s*$/, "") + "\n\n" + block + "\n";

  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, updated, "utf-8");
  fs.renameSync(tmp, file);
}

/** Read a day's timeline file content (empty string if missing). */
export function readTimelineDate(dateStr: string): string {
  try {
    return fs.readFileSync(timelineFilePath(dateStr), "utf-8");
  } catch {
    return "";
  }
}

/** List all available day files, newest first. */
export function listTimelineDates(): string[] {
  try {
    if (!fs.existsSync(TIMELINE_MEMORY_DIR)) return [];
    return fs
      .readdirSync(TIMELINE_MEMORY_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.replace(/\.md$/, ""))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Absolute path of a day's timeline file (for display in the UI). */
export function timelinePath(dateStr: string): string {
  return timelineFilePath(dateStr);
}
