import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  limitTerminalOutput,
  MAX_TERMINAL_OUTPUT_CHUNK_BYTES,
  resolveTerminalCwd,
} from "./manager";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("terminal output limits", () => {
  it("preserves chunks within the IPC byte limit", () => {
    expect(limitTerminalOutput("hello")).toBe("hello");
  });

  it("truncates oversized Unicode output by encoded byte length", () => {
    const output = limitTerminalOutput("你".repeat(MAX_TERMINAL_OUTPUT_CHUNK_BYTES));

    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(MAX_TERMINAL_OUTPUT_CHUNK_BYTES);
    expect(output.length).toBeGreaterThan(0);
  });

  it("does not leave a partial surrogate pair at the truncation boundary", () => {
    const output = limitTerminalOutput("x".repeat(MAX_TERMINAL_OUTPUT_CHUNK_BYTES - 1) + "😀");

    expect(output.endsWith("\ud83d")).toBe(false);
  });

  it("uses the requested session workspace and never falls back to HOME", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepwork-terminal-"));
    dirs.push(root);

    expect(resolveTerminalCwd(root)).toBe(path.resolve(root));
    expect(() => resolveTerminalCwd(path.join(root, "missing"))).toThrow(
      /Terminal workspace is unavailable/,
    );
  });
});
