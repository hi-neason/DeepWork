import { describe, it, expect, vi, afterEach } from "vitest";
import { approvals } from "./approvals";

describe("security/approvals - approval gate", () => {
  // The singleton accumulates pending requests across tests; clean them up at
  // the end of each case.
  afterEach(() => approvals.rejectAll());

  it("requestWithId + respond: resolves the matching Promise by id and passes the decision through", async () => {
    const p = approvals.requestWithId("t1", {
      tool: "write_file",
      risk: "write",
      argsPreview: "a",
    });
    const listener = vi.fn();
    p.then(listener);
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    approvals.respond("t1", "allow");
    await expect(p).resolves.toBe("allow");
  });

  it("emits a 'request' event carrying the approval payload (for IPC forwarding to the renderer dialog)", async () => {
    const onReq = vi.fn();
    approvals.on("request", onReq);
    approvals.requestWithId("t2", {
      tool: "execute",
      risk: "exec",
      argsPreview: "cmd",
    });
    expect(onReq).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t2", tool: "execute", risk: "exec" }),
    );
    approvals.off("request", onReq);
  });

  it("respond silently ignores an unknown id without throwing", () => {
    expect(() => approvals.respond("nope", "allow")).not.toThrow();
  });

  it("rejectAll(): rejects all pending requests (no session argument = used for test cleanup)", async () => {
    const pA = approvals.requestWithId("A", {
      tool: "write_file",
      risk: "write",
      argsPreview: "",
    });
    approvals.rejectAll();
    await expect(pA).resolves.toBe("deny");
  });

  // H-A2 fix: when cancelling one session, only that session's pending requests
  // should be rejected; the parallel session B's approvals must not be denied too.
  it("rejectAll(sessionId) only rejects that session's pending requests without affecting other parallel sessions", async () => {
    const pA = approvals.requestWithId("ta", { tool: "write_file", risk: "write", argsPreview: "", sessionId: "A" });
    const pB = approvals.requestWithId("tb", { tool: "execute", risk: "exec", argsPreview: "", sessionId: "B" });
    approvals.rejectAll("A");
    await expect(pA).resolves.toBe("deny");
    // B's approval is unaffected and remains pending (not resolved)
    const settled = await Promise.race([
      pB.then(() => "settled"),
      new Promise((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(settled).toBe("pending");
  });

  it("a pending request without a sessionId is rejected by any scoped rejectAll", async () => {
    const p = approvals.requestWithId("tc", { tool: "execute", risk: "exec", argsPreview: "" });
    approvals.rejectAll("X");
    await expect(p).resolves.toBe("deny");
  });
});
