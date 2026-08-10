import { describe, it, expect } from "vitest";
import { evaluateApprovalDecision } from "./middleware";
import type { RiskLevel, PermissionMode } from "../../shared/types";

describe("agent/middleware - evaluateApprovalDecision (5 gates)", () => {
  const base = {
    toolName: "write_file",
    risk: "write" as RiskLevel,
    alwaysAllowed: false,
  };

  it("plan mode + destructive tool -> BLOCK (plan-mode)", () => {
    expect(
      evaluateApprovalDecision({ ...base, mode: "plan", unattended: false }),
    ).toEqual({ action: "block", blockReason: "plan-mode" });
  });

  it("plan mode + read-only tool -> ALLOW (free exploration during planning)", () => {
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

  it("unattended + GUI tool -> BLOCK (unattended-gui, no human available to approve)", () => {
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
  it("unattended + exec(execute) -> BLOCK (unattended-highrisk)", () => {
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

  it("unattended + external(MCP) -> BLOCK (unattended-highrisk)", () => {
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

  it("unattended + write tool + auto mode -> ALLOW (file writes allowed within automation)", () => {
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

  it("auto mode + file write -> ALLOW (autoAllowed)", () => {
    expect(
      evaluateApprovalDecision({ ...base, mode: "auto", unattended: false }),
    ).toEqual({ action: "allow" });
  });

  it("auto-write allows writes but asks before shell execution", () => {
    expect(
      evaluateApprovalDecision({ ...base, mode: "auto-write", unattended: false }),
    ).toEqual({ action: "allow" });
    expect(
      evaluateApprovalDecision({
        toolName: "execute",
        risk: "exec",
        mode: "auto-write",
        unattended: false,
        alwaysAllowed: false,
      }),
    ).toEqual({ action: "ask" });
  });

  it("auto-exec allows writes and shell execution but asks before external tools", () => {
    expect(
      evaluateApprovalDecision({
        toolName: "execute",
        risk: "exec",
        mode: "auto-exec",
        unattended: false,
        alwaysAllowed: false,
      }),
    ).toEqual({ action: "allow" });
    expect(
      evaluateApprovalDecision({
        toolName: "mcp_weather",
        risk: "external",
        mode: "auto-exec",
        unattended: false,
        alwaysAllowed: false,
      }),
    ).toEqual({ action: "ask" });
  });

  it("manual + file write + not always_allow -> ASK", () => {
    expect(
      evaluateApprovalDecision({ ...base, mode: "manual", unattended: false }),
    ).toEqual({ action: "ask" });
  });

  it("manual + file write + already always_allow -> ALLOW (pass-through)", () => {
    expect(
      evaluateApprovalDecision({
        ...base,
        mode: "manual",
        unattended: false,
        alwaysAllowed: true,
      }),
    ).toEqual({ action: "allow" });
  });

  it("manual + read-only tool -> ALLOW (no approval needed)", () => {
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

  it("manual + system tool(ask_user) -> ALLOW (whitelist, no approval)", () => {
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

  it("manual + GUI tool + not always_allow -> ASK", () => {
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

  it("manual + GUI tool + still ASK even when always_allow (GUI never pass-through)", () => {
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

  it("manual + external tool(MCP) -> ASK", () => {
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
