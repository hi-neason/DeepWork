/**
 * Shared presentational formatters used across renderer components.
 *
 * These were previously duplicated in several files; keep one canonical
 * implementation here so byte/date/path/model formatting stays consistent.
 */

/** Human-readable byte size, e.g. 1536 -> "1.5 KB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Local HH:MM from a Date (defaults to now). */
export function formatTime(d: Date = new Date()): string {
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Local YYYY-MM-DD from a Date (defaults to today). */
export function formatDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Final path segment, tolerating trailing slashes/backslashes. */
export function basename(p?: string): string {
  if (!p) return "";
  const s = p.replace(/[/\\]+$/, "");
  const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return s.slice(idx + 1) || s;
}

/** Strip the "provider:" prefix from a model id for compact display. */
export function shortModelLabel(id: string): string {
  return id.includes(":") ? id.split(":").slice(1).join(":") : id;
}
