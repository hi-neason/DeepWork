import { describe, it, expect } from "vitest";
import { evaluateApprovalDecision } from "./middleware";
import type { RiskLevel, PermissionMode } from "../../shared/types";

describe("agent/middleware — evaluateApprovalDecision (5 道闸门)", () => {
  const base = {
    toolName: "write_file",
    risk: "write" as RiskLevel,
    alwaysAllowed: false,
  };

  it("plan 模式 + 破坏性工具 → BLOCK (plan-mode)", () => {
    expect(
      evaluateApprovalDecision({ ...base, mode: "plan", unattended: false }),
    ).toEqual({ action: "block", blockReason: "plan-mode" });
  });

  it("plan 模式 + 只读工具 → ALLOW (计划阶段探索自由)", () => {
    expect(
      evaluateApprovalDecision({
        toolName: "read_file",
        risk: "read",
        mode: "plan",
        unattended: false,
        alwaysAllowed: false,
      }),
    ).toEqual({ action: "allow" });
  });

  it("无人值守 + GUI 工具 → BLOCK (unattended-gui, 无人可批)", () => {
    expect(
      evaluateApprovalDecision({
        toolName: "screenshot",
        risk: "read",
        mode: "manual",
        unattended: true,
        alwaysAllowed: false,
      }),
    ).toEqual({ action: "block", blockReason: "unattended-gui" });
  });

  // H-T4: unattended runs have no human to approve, so shell / third-party
  // (MCP) tools must never auto-run — a web_fetch content-injection could
  // otherwise achieve unsupervised RCE. write-level tools may still run when
  // the automation opted into auto mode.
  it("无人值守 + exec(execute) → BLOCK (unattended-highrisk)", () => {
    expect(
      evaluateApprovalDecision({
        toolName: "execute",
        risk: "exec",
        mode: "manual",
        unattended: true,
        alwaysAllowed: false,
      }),
    ).toEqual({ action: "block", blockReason: "unattended-highrisk" });
  });

  it("无人值守 + external(MCP) → BLOCK (unattended-highrisk)", () => {
    expect(
      evaluateApprovalDecision({
        toolName: "mcp_weather",
        risk: "external",
        mode: "auto",
        unattended: true,
        alwaysAllowed: false,
      }),
    ).toEqual({ action: "block", blockReason: "unattended-highrisk" });
  });

  it("无人值守 + write 工具 + auto 模式 → ALLOW (自动化内可写文件)", () => {
    expect(
      evaluateApprovalDecision({
        toolName: "write_file",
        risk: "write",
        mode: "auto",
        unattended: true,
        alwaysAllowed: false,
      }),
    ).toEqual({ action: "allow" });
  });

  it("auto 模式 + 写文件 → ALLOW (autoAllowed)", () => {
    expect(
      evaluateApprovalDecision({ ...base, mode: "auto", unattended: false }),
    ).toEqual({ action: "allow" });
  });

  it("manual + 写文件 + 未 always_allow → ASK", () => {
    expect(
      evaluateApprovalDecision({ ...base, mode: "manual", unattended: false }),
    ).toEqual({ action: "ask" });
  });

  it("manual + 写文件 + 已 always_allow → ALLOW (直通)", () => {
    expect(
      evaluateApprovalDecision({
        ...base,
        mode: "manual",
        unattended: false,
        alwaysAllowed: true,
      }),
    ).toEqual({ action: "allow" });
  });

  it("manual + 只读工具 → ALLOW (无需审批)", () => {
    expect(
      evaluateApprovalDecision({
        toolName: "read_file",
        risk: "read",
        mode: "manual",
        unattended: false,
        alwaysAllowed: false,
      }),
    ).toEqual({ action: "allow" });
  });

  it("manual + 系统工具(ask_user) → ALLOW (白名单免审)", () => {
    expect(
      evaluateApprovalDecision({
        toolName: "ask_user",
        risk: "read",
        mode: "manual",
        unattended: false,
        alwaysAllowed: false,
      }),
    ).toEqual({ action: "allow" });
  });

  it("manual + GUI 工具 + 未 always_allow → ASK", () => {
    expect(
      evaluateApprovalDecision({
        toolName: "mouse_click",
        risk: "read",
        mode: "manual",
        unattended: false,
        alwaysAllowed: false,
      }),
    ).toEqual({ action: "ask" });
  });

  it("manual + GUI 工具 + 即使 always_allow 仍 ASK (GUI 永不直通)", () => {
    expect(
      evaluateApprovalDecision({
        toolName: "mouse_click",
        risk: "read",
        mode: "manual",
        unattended: false,
        alwaysAllowed: true,
      }),
    ).toEqual({ action: "ask" });
  });

  it("manual + external 工具(MCP) → ASK", () => {
    expect(
      evaluateApprovalDecision({
        toolName: "mcp_weather",
        risk: "external",
        mode: "manual",
        unattended: false,
        alwaysAllowed: false,
      }),
    ).toEqual({ action: "ask" });
  });
});
