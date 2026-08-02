import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { ApprovalDecision } from "../../shared/types";

export interface PendingApproval {
  id: string;
  tool: string;
  risk: string;
  argsPreview: string;
}

interface Pending extends PendingApproval {
  resolve: (d: ApprovalDecision) => void;
}

/**
 * Central in-memory approval gate. The agent's wrapToolCall middleware emits
 * a request and awaits a decision; the renderer responds over IPC.
 *
 * GUI tools are never auto-allowable (caller enforces this).
 */
class ApprovalService extends EventEmitter {
  private pending = new Map<string, Pending>();

  request(p: Omit<PendingApproval, "id">): Promise<ApprovalDecision> {
    return this.requestWithId(randomUUID(), p);
  }

  /** Request approval with a caller-chosen id (e.g. the tool_call id). */
  requestWithId(
    id: string,
    p: Omit<PendingApproval, "id">,
  ): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(id, { ...p, id, resolve });
      this.emit("request", { ...p, id } satisfies PendingApproval);
    });
  }

  respond(id: string, decision: ApprovalDecision): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.resolve(decision);
  }

  /** Reject all pending approvals (e.g. on turn cancel). */
  rejectAll(): void {
    for (const [id, p] of this.pending) {
      p.resolve("deny");
      this.pending.delete(id);
    }
  }
}

export const approvals = new ApprovalService();
