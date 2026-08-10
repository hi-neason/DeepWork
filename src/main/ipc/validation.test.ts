import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertExistingFileWithin,
  terminalInputArgsSchema,
  terminalResizeArgsSchema,
} from "./validation";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepwork-ipc-validation-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("IPC validation", () => {
  it("accepts a real file contained by the allowed root", () => {
    const root = tempDir();
    const file = path.join(root, "report.txt");
    fs.writeFileSync(file, "ok");

    expect(assertExistingFileWithin(root, file)).toBe(fs.realpathSync(file));
  });

  it("rejects lexical traversal and symlinks escaping the allowed root", () => {
    const root = tempDir();
    const outside = tempDir();
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "secret");
    const link = path.join(root, "report.txt");
    fs.symlinkSync(secret, link);

    expect(() => assertExistingFileWithin(root, secret)).toThrow(/outside/);
    expect(() => assertExistingFileWithin(root, link)).toThrow(/outside/);
  });

  it("rejects directories, relative paths, oversized input, and invalid PTY sizes", () => {
    const root = tempDir();
    expect(() => assertExistingFileWithin(root, root)).toThrow(/not a file/);
    expect(() => assertExistingFileWithin(root, "report.txt")).toThrow(/absolute/);
    expect(() => terminalInputArgsSchema.parse(["term-1", "x".repeat(65 * 1024)])).toThrow();
    expect(() => terminalResizeArgsSchema.parse(["term-1", 0, 24])).toThrow();
    expect(() => terminalResizeArgsSchema.parse(["term-1", 80, Number.NaN])).toThrow();
  });
});
