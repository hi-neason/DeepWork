import { tool } from "@langchain/core/tools";
import type { ToolInterface } from "@langchain/core/tools";
import type { RiskLevel } from "../../shared/types";

export interface DeepWorkTool {
  tool: ToolInterface;
  risk: RiskLevel;
}

const REGISTRY = new Map<string, RiskLevel>();

/** Severity order — a tool's risk may be raised but never silently lowered. */
const RISK_ORDER: Record<RiskLevel, number> = {
  read: 0,
  write: 1,
  exec: 2,
  external: 3,
};

/** Names owned by DeepWork itself; MCP servers must not claim them. */
const DEFINED_TOOL_NAMES = new Set<string>();

/**
 * deepagents / LangChain built-ins that exist before any annotation runs.
 * Kept explicit so an MCP server can't register a tool called `execute` and
 * inherit the built-in's (lower) risk level or shadow it entirely (C-T4).
 */
const BUILTIN_TOOL_NAMES = new Set([
  "write_file",
  "edit_file",
  "read_file",
  "execute",
  "ls",
  "glob",
  "grep",
  "task",
  "write_todos",
  "ask_user",
]);

/** Wrap a tool and register its risk level. The risk is read by the approval gate. */
export function defineTool(
  risk: RiskLevel,
  func: (...args: any[]) => any,
  config: Record<string, unknown>,
): DeepWorkTool {
  // `tool` typing varies across @langchain/core × zod versions; cast config.
  const t = tool(func as any, config as any) as unknown as ToolInterface;
  REGISTRY.set(t.name, risk);
  DEFINED_TOOL_NAMES.add(t.name);
  return { tool: t, risk };
}

/**
 * Annotate an existing tool (e.g. a deepagents built-in) with a risk level.
 * Monotonic: the stored risk only ever moves up the severity ladder, so a
 * later annotation cannot downgrade an MCP tool from `external` back to
 * `write`/`read` and skip the approval gate (C-T4).
 */
export function annotateRisk(toolName: string, risk: RiskLevel): void {
  const current = REGISTRY.get(toolName);
  if (current !== undefined && RISK_ORDER[current] >= RISK_ORDER[risk]) return;
  REGISTRY.set(toolName, risk);
}

/**
 * Drop a tool's risk annotation entirely. Needed because `annotateRisk` is
 * monotonic — used when a tool provider goes away (and by tests to reset).
 */
export function resetToolRisk(toolName: string): void {
  REGISTRY.delete(toolName);
}

/** True when the name belongs to a DeepWork/agent built-in (not an MCP tool). */
export function isReservedToolName(toolName: string): boolean {
  return (
    DEFINED_TOOL_NAMES.has(toolName) ||
    BUILTIN_TOOL_NAMES.has(toolName) ||
    SYSTEM_TOOLS.has(toolName)
  );
}

export function riskOf(toolName: string): RiskLevel {
  // Fail-closed: an unregistered/unknown tool defaults to the highest-risk
  // level so it can never silently run without approval (H-T1 fix). Built-in
  // and MCP tools are explicitly annotated at startup.
  return REGISTRY.get(toolName) ?? "exec";
}

export function isHighRisk(toolName: string): boolean {
  const r = riskOf(toolName);
  return r === "exec" || r === "external";
}

/** Tool names that are part of the agent's interactive/system set and must never be gated. */
const SYSTEM_TOOLS = new Set([
  "ask_user",
  "write_todos",
  "task",
  "read_file",
  "ls",
  "glob",
  "grep",
]);

export function isSystemTool(toolName: string): boolean {
  return SYSTEM_TOOLS.has(toolName);
}
