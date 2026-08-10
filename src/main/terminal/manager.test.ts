import { describe, expect, it } from "vitest";
import { limitTerminalOutput, MAX_TERMINAL_OUTPUT_CHUNK_BYTES } from "./manager";

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
});
