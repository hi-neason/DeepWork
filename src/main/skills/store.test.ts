import { describe, it, expect, vi, afterEach } from "vitest";

// Mock the paths module so SKILLS_DIR points at a temp dir, isolating tests
// from the real ~/DeepWork/skills.
vi.mock("../config/paths", async (importOriginal) => {
  const f = await import("node:fs");
  const p = await import("node:path");
  const o = await import("node:os");
  const base = f.mkdtempSync(p.join(o.tmpdir(), "dw-skills-"));
  return {
    ...(await importOriginal<typeof import("../config/paths")>()),
    SKILLS_DIR: base,
  };
});

import * as skills from "./store";

const TRAVERSAL_PAYLOADS = [
  "../../../etc",
  "..",
  "../escape",
  "foo/../../bar",
  "foo/bar",
  "good-name/../../evil",
  "",
  "UPPERCASE",
  "with spaces",
  "name;rm -rf /",
  "$(whoami)",
];

describe("skills/store — path traversal protection", () => {
  afterEach(() => {
    // No files should have been created during the rejection tests.
  });

  it("deleteSkill rejects traversal payloads before touching the filesystem", () => {
    for (const payload of TRAVERSAL_PAYLOADS) {
      expect(() => skills.deleteSkill(payload)).toThrow(/Invalid skill name/);
    }
  });

  it("updateSkill rejects traversal payloads", () => {
    for (const payload of TRAVERSAL_PAYLOADS) {
      expect(() => skills.updateSkill(payload, { body: "x" })).toThrow(
        /Invalid skill name/,
      );
    }
  });

  it("renameSkill rejects traversal in oldName", () => {
    for (const payload of TRAVERSAL_PAYLOADS) {
      expect(() => skills.renameSkill(payload, "valid-name")).toThrow(
        /Invalid skill name/,
      );
    }
  });

  it("exportSkill rejects traversal payloads", () => {
    for (const payload of TRAVERSAL_PAYLOADS) {
      expect(() => skills.exportSkill(payload, "/tmp")).toThrow(
        /Invalid skill name/,
      );
    }
  });

  it("accepts valid kebab-case names without a validation error", () => {
    // deleteSkill for a non-existent valid name is a silent no-op (returns
    // void); it must NOT throw "Invalid skill name".
    expect(() => skills.deleteSkill("valid-name")).not.toThrow();
    expect(() => skills.deleteSkill("a")).not.toThrow();
    expect(() => skills.deleteSkill("my-skill-2")).not.toThrow();
  });
});
