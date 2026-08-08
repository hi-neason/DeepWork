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

describe("tools/registry — 风险注册表", () => {
  afterEach(() => {
    // annotateRisk 单调不可降级，跨用例清理必须用 resetToolRisk
    for (const name of ["tmp_tool_a", "tmp_tool_b"]) resetToolRisk(name);
  });

  it("riskOf 未知工具默认返回 exec（fail-closed，H-T1 修复前默认 read 会免审放行）", () => {
    expect(riskOf("does_not_exist_xyz")).toBe("exec");
  });

  it("annotateRisk 能为任意工具名标注风险，riskOf 能读回", () => {
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

  // C-T4：MCP 工具被标 external 后，后续内建注解不得把它降级成 write/read
  it("annotateRisk 单调不降级：external 不会被 write/read 覆盖", () => {
    annotateRisk("tmp_tool_a", "external");
    annotateRisk("tmp_tool_a", "write");
    expect(riskOf("tmp_tool_a")).toBe("external");
    annotateRisk("tmp_tool_a", "read");
    expect(riskOf("tmp_tool_a")).toBe("external");
  });

  it("annotateRisk 可升级：read → exec 生效", () => {
    annotateRisk("tmp_tool_a", "read");
    annotateRisk("tmp_tool_a", "exec");
    expect(riskOf("tmp_tool_a")).toBe("exec");
  });

  it("resetToolRisk 清除后回落到 fail-closed 默认值 exec", () => {
    annotateRisk("tmp_tool_a", "read");
    resetToolRisk("tmp_tool_a");
    expect(riskOf("tmp_tool_a")).toBe("exec");
  });

  // C-T4：MCP 服务器不得注册与内建同名的工具（劫持 + 降级风险）
  it("isReservedToolName 覆盖内建 / 系统 / defineTool 注册的名字", () => {
    expect(isReservedToolName("execute")).toBe(true);
    expect(isReservedToolName("write_file")).toBe(true);
    expect(isReservedToolName("ask_user")).toBe(true);
    expect(isReservedToolName("some_mcp_tool")).toBe(false);
  });

  it("isSystemTool: 系统工具白名单命中", () => {
    expect(isSystemTool("ask_user")).toBe(true);
    expect(isSystemTool("write_todos")).toBe(true);
    expect(isSystemTool("read_file")).toBe(true);
    expect(isSystemTool("ls")).toBe(true);
    expect(isSystemTool("glob")).toBe(true);
    expect(isSystemTool("grep")).toBe(true);
    expect(isSystemTool("task")).toBe(true);
  });

  it("isSystemTool: 非白名单工具返回 false", () => {
    expect(isSystemTool("execute")).toBe(false);
    expect(isSystemTool("write_file")).toBe(false);
    expect(isSystemTool("random_tool")).toBe(false);
  });

  it("defineTool 返回带 risk 元数据的包装对象，并登记到注册表", () => {
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
