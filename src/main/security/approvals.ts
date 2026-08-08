import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { ApprovalDecision } from "../../shared/types";

/**
 * Default wait for a human decision. If the renderer never responds (closed
 * window, dropped IPC), the turn must not hang forever — the request auto-denies
 * after this many ms (fail-closed). H-T3.
 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export interface PendingApproval {
  id: string;
  /** Owning session/thread id, used to scope cancel to one session. */
  sessionId?: string;
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
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      let settled = false;
      const finish = (d: ApprovalDecision) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        resolve(d);
      };
      const pending: Pending = { ...p, id, resolve: finish };
      this.pending.set(id, pending);
      this.emit("request", { ...p, id } satisfies PendingApproval);

      const onAbort = () => finish("deny");
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      // Auto-deny if no human responds in time, so an unattended/crashed
      // renderer can't leave an agent turn hung forever.
      const timeoutMs = opts.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
      const timer =
        timeoutMs > 0 ? setTimeout(() => finish("deny"), timeoutMs) : undefined;
    });
  }

  respond(id: string, decision: ApprovalDecision): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.resolve(decision);
  }

  /**
   * Reject pending approvals. With no sessionId, rejects everything (used by
   * test teardown). With a sessionId, only that session's pending requests are
   * denied — cancelling session A must not reject session B's tool approvals
   * (H-A2 fix).
   */
  rejectAll(sessionId?: string): void {
    for (const [id, p] of this.pending) {
      // Scoped reject: skip other sessions' requests. Requests with no owning
      // session are always denied (fail-closed — an unattributed approval must
      // never outlive a cancel and hang forever).
      if (
        sessionId !== undefined &&
        p.sessionId !== undefined &&
        p.sessionId !== sessionId
      )
        continue;
      p.resolve("deny");
      this.pending.delete(id);
    }
  }
}

export const approvals = new ApprovalService();
