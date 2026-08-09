import fs from "node:fs";
import path from "node:path";
import { TIMELINE_MEMORY_DIR } from "../config/paths";
import { atomicWriteFileSync } from "./atomic";

const TZ = "Asia/Shanghai";

/** Today's date as YYYY-MM-DD in the app's timezone (Asia/Shanghai). */
export function todayStr(d: Date = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

/** Absolute path of a given day's timeline file. */
export function timelineFilePath(dateStr: string): string {
  return path.join(TIMELINE_MEMORY_DIR, `${dateStr}.md`);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Reject malformed dates (path-traversal payloads like "../../x") at the boundary. */
function assertSafeDate(dateStr: string): void {
  if (typeof dateStr !== "string" || !DATE_RE.test(dateStr)) {
    throw new Error(`Invalid timeline date: ${JSON.stringify(dateStr)}`);
  }
}

/** Resolve a date to its absolute file path, guaranteeing it stays inside TIMELINE_MEMORY_DIR. */
function safeTimelinePath(dateStr: string): string {
  assertSafeDate(dateStr);
  const resolved = path.resolve(timelineFilePath(dateStr));
  const base = path.resolve(TIMELINE_MEMORY_DIR);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Timeline path escapes memory dir: ${dateStr}`);
  }
  return resolved;
}

export interface TimelineAppend {
  /** ISO-ish day string; defaults to today. */
  date?: string;
  /** Project (workspace) name this conversation belonged to. */
  project: string;
  /** Distilled point strings; each becomes a numbered item under the project. */
  points: string[];
}

/** Locate a project's `## <project>` section: returns [headingIdx, nextHeadingOrEof). */
function projectSectionBounds(
  lines: string[],
  project: string,
): { start: number; end: number } | null {
  const heading = `## ${project}`;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === heading) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Last numbered-list item index within [start+1, end), or start if none. */
function lastItemIndex(lines: string[], start: number, end: number): number {
  let last = start;
  for (let i = start + 1; i < end; i++) {
    if (/^\d+\.\s/.test(lines[i].trim())) last = i;
  }
  return last;
}

/** Count existing numbered items within [start+1, end). */
function countNumbered(lines: string[], start: number, end: number): number {
  let n = 0;
  for (let i = start + 1; i < end; i++) {
    if (/^\d+\.\s/.test(lines[i].trim())) n++;
  }
  return n;
}

/**
 * Append distilled points to today's timeline file, grouped by project.
 *
 * Resulting layout:
 *   # 2026-08-08 Timeline memory
 *   ## PROJECT_A
 *   1. xxxxxx
 *   2. xxxxxxx
 *   ## PROJECT_B
 *   1. xxxxxxxxx
 *   2. xxxxxxxx
 *
 * Each call appends to the matching project section (continuing the numbering)
 * or creates the section if absent. Atomic write (tmp + rename) prevents
 * corruption from concurrent turns.
 */
export function appendTimelineEntry(entry: TimelineAppend): void {
  const date = entry.date ?? todayStr();
  // Validate here too — the date may come from a caller-supplied entry (C-S1).
  const file = safeTimelinePath(date);
  fs.mkdirSync(TIMELINE_MEMORY_DIR, { recursive: true });

  let lines: string[];
  if (fs.existsSync(file)) {
    lines = fs.readFileSync(file, "utf-8").split("\n");
  } else {
    lines = [`# ${date} Timeline memory`, ""];
  }

  const points = entry.points
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (points.length === 0) return;

  const bounds = projectSectionBounds(lines, entry.project);
  if (bounds) {
    const existing = lines
      .slice(bounds.start + 1, bounds.end)
      .map((l) => l.replace(/^\d+\.\s*/, "").trim().toLowerCase());
    const fresh = points.filter(
      (p) => !existing.includes(p.toLowerCase()),
    );
    if (fresh.length === 0) return;

    let next = countNumbered(lines, bounds.start, bounds.end) + 1;
    const insertAt = lastItemIndex(lines, bounds.start, bounds.end) + 1;
    const newLines = fresh.map((p) => `${next++}. ${p}`);
    lines.splice(insertAt, 0, ...newLines);
  } else {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
      lines.push("");
    }
    lines.push(
      `## ${entry.project}`,
      ...points.map((p, i) => `${i + 1}. ${p}`),
    );
  }

  const updated = lines.join("\n").replace(/\n+$/, "\n");
  atomicWriteFileSync(file, updated);
}

/** Read a day's timeline file content (empty string if missing). */
export function readTimelineDate(dateStr: string): string {
  try {
    return fs.readFileSync(safeTimelinePath(dateStr), "utf-8");
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
  return safeTimelinePath(dateStr);
}
