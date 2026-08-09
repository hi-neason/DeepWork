import fs from "node:fs";
import path from "node:path";
import { PROJECT_MEMORY_DIR } from "../config/paths";

const TZ = "Asia/Shanghai";

/** Today's date as YYYY-MM-DD in the app's timezone (Asia/Shanghai). */
export function todayStr(d: Date = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

/** Map a project name to a safe on-disk filename (project basename as id). */
function safeFileName(project: string): string {
  const base = project.trim() || "untitled";
  return base.replace(/[\\/:*?"<>|]/g, "_");
}

/** Absolute path of a project's memory file. */
export function projectMemoryFilePath(project: string): string {
  return path.join(PROJECT_MEMORY_DIR, `${safeFileName(project)}.md`);
}

export interface ProjectMemoryAppend {
  /** Project (workspace) name this memory belongs to. */
  project: string;
  /** ISO-ish day string; defaults to today. */
  date?: string;
  /** Distilled point strings; each becomes a numbered item under the date. */
  points: string[];
}

/** Locate a `## <date>` section: returns [headingIdx, nextHeadingOrEof). */
function dateSectionBounds(
  lines: string[],
  date: string,
): { start: number; end: number } | null {
  const heading = `## ${date}`;
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
 * Append distilled points to a project's memory file, grouped by date.
 *
 * Resulting layout:
 *   # DeepWork project memory
 *   ## 2026-08-08
 *   1. xxxxxx
 *   2. xxxxxxx
 *   ## 2026-08-07
 *   1. yyyyyyy
 *
 * Each call appends to the matching date section (continuing that day's
 * numbering) or creates the section if absent. Atomic write (tmp + rename)
 * prevents corruption from concurrent turns.
 */
export function appendProjectMemoryEntry(entry: ProjectMemoryAppend): void {
  const date = entry.date ?? todayStr();
  const file = projectMemoryFilePath(entry.project);
  fs.mkdirSync(PROJECT_MEMORY_DIR, { recursive: true });

  let lines: string[];
  if (fs.existsSync(file)) {
    lines = fs.readFileSync(file, "utf-8").split("\n");
  } else {
    lines = [`# ${entry.project} project memory`, ""];
  }

  const points = entry.points
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (points.length === 0) return;

  const bounds = dateSectionBounds(lines, date);
  if (bounds) {
    const existing = lines
      .slice(bounds.start + 1, bounds.end)
      .map((l) => l.replace(/^\d+\.\s*/, "").trim().toLowerCase());
    const fresh = points.filter((p) => !existing.includes(p.toLowerCase()));
    if (fresh.length === 0) return;

    let next = countNumbered(lines, bounds.start, bounds.end) + 1;
    const insertAt = lastItemIndex(lines, bounds.start, bounds.end) + 1;
    const newLines = fresh.map((p) => `${next++}. ${p}`);
    lines.splice(insertAt, 0, ...newLines);
  } else {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
      lines.push("");
    }
    // Newest date first: a fresh date goes above older ones.
    const insertAt =
      lines.length > 0 && lines[0].startsWith("# ") ? 2 : lines.length;
    const block = [`## ${date}`, ...points.map((p, i) => `${i + 1}. ${p}`)];
    lines.splice(insertAt, 0, ...block);
  }

  const updated = lines.join("\n").replace(/\n+$/, "\n");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, updated, "utf-8");
  fs.renameSync(tmp, file);
}

/** Read a project's memory file content (empty string if missing). */
export function readProjectMemory(project: string): string {
  try {
    return fs.readFileSync(projectMemoryFilePath(project), "utf-8");
  } catch {
    return "";
  }
}

/** List all known project names (newest file modification first). */
export function listProjects(): string[] {
  try {
    if (!fs.existsSync(PROJECT_MEMORY_DIR)) return [];
    return fs
      .readdirSync(PROJECT_MEMORY_DIR)
      .filter((f) => f.endsWith(".md") && !f.endsWith(".tmp"))
      .map((f) => ({
        name: f.replace(/\.md$/, ""),
        mtime: fs.statSync(path.join(PROJECT_MEMORY_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((x) => x.name);
  } catch {
    return [];
  }
}

/** Absolute path of a project's memory file (for display in the UI). */
export function projectMemoryPath(project: string): string {
  return projectMemoryFilePath(project);
}
