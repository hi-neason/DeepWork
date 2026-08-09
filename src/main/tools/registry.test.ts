import { describe, it, expect, afterEach } from "vitest";
import {
  riskOf,
  isHighRisk,
  isSystemTool,
  annotateRisk,
  defineTool,
  resetToolRisk,
  isReservedToolName,
} from "./registry";
import type { RiskLevel } from "../../shared/types";

describe("tools/registry - risk registry", () => {
  afterEach(() => {
    // annotateRisk is monotonic and cannot be downgraded, so cross-case cleanup
    // must use resetToolRisk
    for (const name of ["tmp_tool_a", "tmp_tool_b"]) resetToolRisk(name);
  });

  it("riskOf returns exec by default for unknown tools (fail-closed; before the H-T1 fix the default was read, which bypassed approval)", () => {
    expect(riskOf("does_not_exist_xyz")).toBe("exec");
  });

  it("annotateRisk can annotate risk for any tool name and riskOf can read it back", () => {
    annotateRisk("tmp_tool_a", "exec");
    expect(riskOf("tmp_tool_a")).toBe("exec");
    annotateRisk("tmp_tool_a", "external");
    expect(riskOf("tmp_tool_a")).toBe("external");
  });

  it.each<[RiskLevel, boolean]>([
    ["exec", true],
    ["external", true],
    ["write", false],
    ["read", false],
  ])("isHighRisk: %s -> %s", (level, expected) => {
    resetToolRisk("tmp_tool_b");
    annotateRisk("tmp_tool_b", level);
    expect(isHighRisk("tmp_tool_b")).toBe(expected);
  });

  // C-T4: after an MCP tool is marked external, subsequent built-in annotations
  // must not downgrade it to write/read
  it("annotateRisk is monotonic without downgrade: external is not overwritten by write/read", () => {
    annotateRisk("tmp_tool_a", "external");
    annotateRisk("tmp_tool_a", "write");
    expect(riskOf("tmp_tool_a")).toBe("external");
    annotateRisk("tmp_tool_a", "read");
    expect(riskOf("tmp_tool_a")).toBe("external");
  });

  it("annotateRisk can upgrade: read -> exec takes effect", () => {
    annotateRisk("tmp_tool_a", "read");
    annotateRisk("tmp_tool_a", "exec");
    expect(riskOf("tmp_tool_a")).toBe("exec");
  });

  it("after resetToolRisk clears the annotation it falls back to the fail-closed default exec", () => {
    annotateRisk("tmp_tool_a", "read");
    resetToolRisk("tmp_tool_a");
    expect(riskOf("tmp_tool_a")).toBe("exec");
  });

  // C-T4: an MCP server must not register a tool with the same name as a
  // built-in tool (hijacking + downgrade risk)
  it("isReservedToolName covers names registered by built-in / system / defineTool", () => {
    expect(isReservedToolName("execute")).toBe(true);
    expect(isReservedToolName("write_file")).toBe(true);
    expect(isReservedToolName("ask_user")).toBe(true);
    expect(isReservedToolName("some_mcp_tool")).toBe(false);
  });

  it("isSystemTool: matches the system-tool whitelist", () => {
    expect(isSystemTool("ask_user")).toBe(true);
    expect(isSystemTool("write_todos")).toBe(true);
    expect(isSystemTool("read_file")).toBe(true);
    expect(isSystemTool("ls")).toBe(true);
    expect(isSystemTool("glob")).toBe(true);
    expect(isSystemTool("grep")).toBe(true);
    expect(isSystemTool("task")).toBe(true);
  });

  it("isSystemTool: returns false for non-whitelisted tools", () => {
    expect(isSystemTool("execute")).toBe(false);
    expect(isSystemTool("write_file")).toBe(false);
    expect(isSystemTool("random_tool")).toBe(false);
  });

  it("defineTool returns a wrapped object with risk metadata and registers it", () => {
    const wrapped = defineTool(
      "write" as RiskLevel,
      () => "ok",
      { name: "unit_test_tool", description: "test" } as any,
    );
    expect(wrapped).toHaveProperty("tool");
    expect(wrapped).toHaveProperty("risk", "write");
    expect(typeof wrapped.tool.invoke).toBe("function");
    expect(riskOf("unit_test_tool")).toBe("write");
  });
});
