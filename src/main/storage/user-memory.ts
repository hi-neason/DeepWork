import fs from "node:fs";
import path from "node:path";
import { USER_MEMORY_DIR } from "../config/paths";
import { atomicWriteFileSync } from "./atomic";

/** The four fixed sections of the user's global memory MD file. */
export const MEMORY_SECTIONS = [
  "personal", // personal background
  "workstyle", // work style / approach
  "focus", // current focus
  "recent", // recent updates
] as const;

export type MemorySectionId = (typeof MEMORY_SECTIONS)[number];

/** Canonical (English) section headings used in the user memory MD file. */
const DEFAULT_HEADINGS: Record<MemorySectionId, string> = {
  personal: "Personal background",
  workstyle: "Work style",
  focus: "Current focus",
  recent: "Recent updates",
};

export const MEMORY_FILE = path.join(USER_MEMORY_DIR, "user_memory.md");

/**
 * Parse the memory.md file into a map of section-id → markdown body string.
 * Each section is delimited by `## <heading>` lines. Content before the first
 * heading is treated as a preamble (e.g. a title line) and discarded.
 */
export function parseMemorySections(markdown: string): Map<MemorySectionId, string> {
  const result = new Map<MemorySectionId, string>();
  // Initialize all sections as empty
  for (const s of MEMORY_SECTIONS) result.set(s, "");

  const lines = markdown.split("\n");
  let currentSection: MemorySectionId | null = null;
  const buf: string[] = [];

  const flush = () => {
    if (currentSection != null) {
      result.set(currentSection, buf.join("\n").trimEnd());
    }
    buf.length = 0;
  };

  for (const raw of lines) {
    const m = raw.match(/^##\s+(.+)$/);
    if (m) {
      flush();
      const heading = m[1].trim();
      // Match the heading to a section id by its canonical English heading.
      currentSection = MEMORY_SECTIONS.find((s) => {
        const c = DEFAULT_HEADINGS[s];
        return heading.includes(c) || c.includes(heading);
      }) ?? currentSection; // unknown heading → keep in current section
      continue;
    }
    if (currentSection != null) {
      buf.push(raw);
    }
  }
  flush();

  return result;
}

/** Rebuild the full MD string from a sections map. */
export function serializeMemorySections(sections: Map<MemorySectionId, string>): string {
  const parts: string[] = [];
  for (const s of MEMORY_SECTIONS) {
    const body = sections.get(s) ?? "";
    parts.push(`## ${DEFAULT_HEADINGS[s]}\n\n${body || ""}`);
  }
  return parts.join("\n\n") + "\n";
}

// ---- File I/O -------------------------------------------------------------

/** Ensure the user memory file exists with the default template. Idempotent. */
export function ensureMemoryFile(): void {
  if (fs.existsSync(MEMORY_FILE)) return;
  const empty = serializeMemorySections(new Map());
  fs.mkdirSync(USER_MEMORY_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_FILE, empty, "utf-8");
}

/** Read and parse memory.md into sections. Returns empty map on error. */
export function readUserMemory(): Map<MemorySectionId, string> {
  try {
    ensureMemoryFile();
    const raw = fs.readFileSync(MEMORY_FILE, "utf-8");
    return parseMemorySections(raw);
  } catch {
    return new Map();
  }
}

/** Write sections back to memory.md atomically (unique tmp + fsync + rename). */
export function saveUserMemory(sections: Map<MemorySectionId, string>): void {
  ensureMemoryFile();
  const serialized = serializeMemorySections(sections);
  atomicWriteFileSync(MEMORY_FILE, serialized);
}

/** Append a timestamped entry to the "Recent updates" section. */
export function appendToRecent(content: string, source?: string): void {
  const sections = readUserMemory();
  // Locale-neutral timestamp (YYYY-MM-DD HH:MM:SS in Asia/Shanghai) so the
  // memory file format doesn't depend on the machine's locale.
  const ts = new Date().toLocaleString("en-CA", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
  const tag = source ? ` — *${source}*` : "";
  const entry = `- **${ts}**${tag}\n  ${content}`;
  const existing = sections.get("recent")?.trim() ?? "";
  sections.set("recent", existing ? `${existing}\n${entry}` : entry);
  saveUserMemory(sections);
}

/** Return the full raw markdown content of memory.md. For injection into prompts. */
export function readRawMemory(): string {
  try {
    ensureMemoryFile();
    return fs.readFileSync(MEMORY_FILE, "utf-8");
  } catch {
    return "";
  }
}

/** Overwrite memory.md with the given raw markdown content (atomic write). */
export function saveRawMemory(markdown: string): void {
  ensureMemoryFile();
  atomicWriteFileSync(MEMORY_FILE, markdown);
}
