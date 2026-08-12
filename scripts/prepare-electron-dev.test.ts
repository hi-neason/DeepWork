import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("macOS development bundle identity", () => {
  it("keeps version fingerprints outside the fixed DeepWork.app basename", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "scripts/prepare-electron-dev.mjs"), "utf8");
    expect(source).toContain('path.join(cacheRoot, cacheKey, "DeepWork.app")');
    expect(source).not.toMatch(/`DeepWork-\$\{electronVersion\}-\$\{fingerprint\}\.app`/);
    expect(source).toContain('replacePlistString("CFBundleDisplayName", "DeepWork")');
    expect(source).toContain('replacePlistString("CFBundleExecutable", "DeepWork")');
  });
});
