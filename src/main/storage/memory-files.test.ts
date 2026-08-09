import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// timeline-memory.ts / project-memory.ts persist state into the directory
// specified by config/paths. Here a temporary directory is created inside the
// mock factory and used as TIMELINE_MEMORY_DIR / PROJECT_MEMORY_DIR, isolating
// the real ~/DeepWork and ensuring the temporary path is captured at module load.
vi.mock("../config/paths", async (importOriginal) => {
  const f = await import("node:fs");
  const p = await import("node:path");
  const o = await import("node:os");
  const base = f.mkdtempSync(p.join(o.tmpdir(), "dw-memfiles-"));
  return {
    ...(await importOriginal<typeof import("../config/paths")>()),
    TIMELINE_MEMORY_DIR: p.join(base, "timeline"),
    PROJECT_MEMORY_DIR: p.join(base, "project"),
  };
});

import * as paths from "../config/paths";
import * as timeline from "./timeline-memory";
import * as project from "./project-memory";

describe("storage/timeline-memory", () => {
  const tlDir = paths.TIMELINE_MEMORY_DIR;
  beforeEach(() => {
    fs.mkdirSync(tlDir, { recursive: true });
    fs.mkdirSync(paths.PROJECT_MEMORY_DIR, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(path.dirname(tlDir), { recursive: true, force: true });
  });

  it("todayStr returns YYYY-MM-DD for Asia/Shanghai", () => {
    expect(timeline.todayStr(new Date("2026-08-08T10:00:00+08:00"))).toBe("2026-08-08");
  });

  it("the first append generates a title + project section + ordered numbering", () => {
    const date = "2026-08-08";
    timeline.appendTimelineEntry({ date, project: "DeepWork", points: ["做了 A", "做了 B"] });
    const file = path.join(tlDir, `${date}.md`);
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain(`# ${date} Timeline memory`);
    expect(content).toContain("## DeepWork");
    expect(content).toContain("1. 做了 A");
    expect(content).toContain("2. 做了 B");
  });

  it("continues numbering for the same project and deduplicates identical entries", () => {
    timeline.appendTimelineEntry({ date: "2026-08-08", project: "P", points: ["x"] });
    timeline.appendTimelineEntry({ date: "2026-08-08", project: "P", points: ["x", "y"] });
    const content = fs.readFileSync(path.join(tlDir, "2026-08-08.md"), "utf-8");
    expect(content).toContain("1. x");
    expect(content).toContain("2. y");
    expect(content.split("1. x").length - 1).toBe(1);
  });

  it("different projects each get their own section", () => {
    timeline.appendTimelineEntry({ date: "2026-08-08", project: "A", points: ["a1"] });
    timeline.appendTimelineEntry({ date: "2026-08-08", project: "B", points: ["b1"] });
    const content = fs.readFileSync(path.join(tlDir, "2026-08-08.md"), "utf-8");
    expect(content).toContain("## A");
    expect(content).toContain("## B");
  });

  it("does not write a file for empty points", () => {
    timeline.appendTimelineEntry({ project: "P", points: ["   ", ""] });
    expect(fs.existsSync(path.join(tlDir, "2026-08-08.md"))).toBe(false);
  });

  // C-S1 regression: date was concatenated into the path without validation,
  // allowing path traversal to read arbitrary markdown outside the DeepWork
  // directory. After the fix, readTimelineDate/timelinePath validate the format
  // at the boundary and require the resolved path prefix to stay inside
  // TIMELINE_MEMORY_DIR; traversal neither reads external files nor leaks paths.
  it("readTimelineDate rejects a date containing ../ and does not read files outside the directory (C-S1 path traversal protection)", () => {
    // Place a normal file inside the timeline directory
    timeline.appendTimelineEntry({ date: "2026-08-08", project: "P", points: ["safe"] });
    // Place a decoy outside the timeline directory and confirm traversal cannot read it
    const decoyDir = path.dirname(tlDir);
    fs.writeFileSync(path.join(decoyDir, "secret-2026-08-08.md"), "LEAKED");

    const normal = timeline.readTimelineDate("2026-08-08");
    expect(normal).toContain("safe");

    const traversal = timeline.readTimelineDate("../../secret-2026-08-08");
    expect(traversal).toBe(""); // traversal is blocked; decoy content is not returned
    expect(traversal).not.toContain("LEAKED");

    // A malformed value (not YYYY-MM-DD) also safely returns an empty string
    expect(timeline.readTimelineDate("not-a-date")).toBe("");
  });

  it("timelinePath throws for an invalid date rather than returning an out-of-bounds path", () => {
    expect(() => timeline.timelinePath("../escape")).toThrow();
  });
});

describe("storage/project-memory", () => {
  const pjDir = paths.PROJECT_MEMORY_DIR;
  beforeEach(() => {
    fs.mkdirSync(pjDir, { recursive: true });
    fs.mkdirSync(paths.TIMELINE_MEMORY_DIR, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(path.dirname(pjDir), { recursive: true, force: true });
  });

  it("safeFileName replaces invalid filename characters with underscores (validates projectMemoryFilePath output)", () => {
    const p = project.projectMemoryFilePath("a/b:c*?d");
    // The directory separator in the path is allowed; verify that invalid
    // characters in the filename portion have been replaced with underscores
    expect(path.basename(p)).toBe("a_b_c__d.md");
    expect(p.endsWith("a_b_c__d.md")).toBe(true);
  });

  it("groups by date with the newest date on top", () => {
    project.appendProjectMemoryEntry({ project: "P", date: "2026-08-07", points: ["old"] });
    project.appendProjectMemoryEntry({ project: "P", date: "2026-08-08", points: ["new"] });
    const content = fs.readFileSync(project.projectMemoryPath("P"), "utf-8");
    const idxNew = content.indexOf("## 2026-08-08");
    const idxOld = content.indexOf("## 2026-08-07");
    expect(idxNew).toBeGreaterThanOrEqual(0);
    expect(idxNew).toBeLessThan(idxOld);
  });

  it("deduplicates and continues numbering within the same date", () => {
    project.appendProjectMemoryEntry({ project: "P", date: "2026-08-08", points: ["m"] });
    project.appendProjectMemoryEntry({ project: "P", date: "2026-08-08", points: ["m", "n"] });
    const content = fs.readFileSync(project.projectMemoryPath("P"), "utf-8");
    expect(content).toContain("1. m");
    expect(content).toContain("2. n");
    expect(content.split("1. m").length - 1).toBe(1);
  });
});
