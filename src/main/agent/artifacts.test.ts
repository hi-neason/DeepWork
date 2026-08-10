import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanArtifacts } from "./artifacts";

const dirs: string[] = [];

function fixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepwork-artifacts-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("artifact scanning", () => {
  it("lists deliverables from an isolated session workspace", () => {
    const root = fixtureDir();
    fs.writeFileSync(path.join(root, "report.md"), "report");
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "nested", "chart.csv"), "a,b");
    fs.mkdirSync(path.join(root, ".deepwork"));
    fs.writeFileSync(path.join(root, ".deepwork", "internal.txt"), "hidden");

    expect(scanArtifacts(root).map((item) => item.relativePath).sort()).toEqual([
      "nested/chart.csv",
      "report.md",
    ]);
  });

  it("omits source, dependency, and transient files from a project scan", () => {
    const root = fixtureDir();
    fs.writeFileSync(path.join(root, "deliverable.pdf"), "pdf");
    fs.writeFileSync(path.join(root, "deepwork.log"), "log");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "app.ts"), "source");
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "pkg.js"), "dependency");

    expect(scanArtifacts(root, true).map((item) => item.name)).toEqual(["deliverable.pdf"]);
  });
});
