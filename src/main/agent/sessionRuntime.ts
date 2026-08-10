import type { PermissionMode } from "../../shared/types";

/** Ephemeral per-session state that must never leak across chats. */
export class SessionRuntime {
  private readonly alwaysAllowed = new Map<string, Set<string>>();
  private readonly workspace = new Map<string, string>();
  private readonly model = new Map<string, string>();
  private readonly mode = new Map<string, PermissionMode>();
  private readonly unattended = new Set<string>();

  getWorkspace(sessionId: string): string | undefined {
    return this.workspace.get(sessionId);
  }

  setWorkspace(sessionId: string, workspace?: string): void {
    if (workspace) this.workspace.set(sessionId, workspace);
    else this.workspace.delete(sessionId);
  }

  getModel(sessionId: string): string | undefined {
    return this.model.get(sessionId);
  }

  setModel(sessionId: string, model?: string): void {
    if (model) this.model.set(sessionId, model);
    else this.model.delete(sessionId);
  }

  getMode(sessionId: string): PermissionMode | undefined {
    return this.mode.get(sessionId);
  }

  setMode(sessionId: string, mode?: PermissionMode): void {
    if (mode) this.mode.set(sessionId, mode);
    else this.mode.delete(sessionId);
  }

  getAlwaysAllowed(sessionId: string): ReadonlySet<string> | undefined {
    return this.alwaysAllowed.get(sessionId);
  }

  allowTool(sessionId: string, toolName: string): void {
    let tools = this.alwaysAllowed.get(sessionId);
    if (!tools) {
      tools = new Set<string>();
      this.alwaysAllowed.set(sessionId, tools);
    }
    tools.add(toolName);
  }

  clearAlwaysAllowed(): void {
    this.alwaysAllowed.clear();
  }

  hasWorkspace(sessionId: string): boolean {
    return this.workspace.has(sessionId);
  }

  setUnattended(sessionId: string, active: boolean): void {
    if (active) this.unattended.add(sessionId);
    else this.unattended.delete(sessionId);
  }

  isUnattended(sessionId: string): boolean {
    return this.unattended.has(sessionId);
  }

  forget(sessionId: string): void {
    this.alwaysAllowed.delete(sessionId);
    this.workspace.delete(sessionId);
    this.model.delete(sessionId);
    this.mode.delete(sessionId);
    this.unattended.delete(sessionId);
  }
}
