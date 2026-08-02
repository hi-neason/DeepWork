import { tool } from "@langchain/core/tools";
import type { ToolInterface } from "@langchain/core/tools";
import type { RiskLevel } from "../../shared/types";

export interface DeepWorkTool {
  tool: ToolInterface;
  risk: RiskLevel;
}

const REGISTRY = new Map<string, RiskLevel>();

/** Wrap a tool and register its risk level. The risk is read by the approval gate. */
export function defineTool(
  risk: RiskLevel,
  func: (...args: any[]) => any,
  config: Record<string, unknown>,
): DeepWorkTool {
  // `tool` typing varies across @langchain/core × zod versions; cast config.
  const t = tool(func as any, config as any) as unknown as ToolInterface;
  REGISTRY.set(t.name, risk);
  return { tool: t, risk };
}

/** Annotate an existing tool (e.g. a deepagents built-in) with a risk level. */
export function annotateRisk(toolName: string, risk: RiskLevel): void {
  REGISTRY.set(toolName, risk);
}

export function riskOf(toolName: string): RiskLevel {
  return REGISTRY.get(toolName) ?? "read";
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
