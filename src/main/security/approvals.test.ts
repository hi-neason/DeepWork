import { describe, it, expect, vi, afterEach } from "vitest";
import { approvals } from "./approvals";

describe("security/approvals — 审批门", () => {
  // 单例跨测试会累积 pending，每个用例结束统一清理。
  afterEach(() => approvals.rejectAll());

  it("requestWithId + respond: 按 id 唤醒对应 Promise，决策透传", async () => {
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

  it("emit 'request' 事件携带审批载荷（供 IPC 转发到渲染层弹窗）", async () => {
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

  it("respond 未知 id 时静默忽略，不抛错", () => {
    expect(() => approvals.respond("nope", "allow")).not.toThrow();
  });

  it("rejectAll(): 拒掉所有 pending（无会话参数 = 测试清理用）", async () => {
    const pA = approvals.requestWithId("A", {
      tool: "write_file",
      risk: "write",
      argsPreview: "",
    });
    approvals.rejectAll();
    await expect(pA).resolves.toBe("deny");
  });

  // H-A2 修复：cancel 一个会话时，只应拒掉该会话的 pending，
  // 不该把并行会话 B 的审批也一并 deny。
  it("rejectAll(sessionId) 只拒该会话的 pending，不误伤其他并行会话", async () => {
    const pA = approvals.requestWithId("ta", { tool: "write_file", risk: "write", argsPreview: "", sessionId: "A" });
    const pB = approvals.requestWithId("tb", { tool: "execute", risk: "exec", argsPreview: "", sessionId: "B" });
    approvals.rejectAll("A");
    await expect(pA).resolves.toBe("deny");
    // B 的审批不受影响，仍 pending（未被 resolve）
    const settled = await Promise.race([
      pB.then(() => "settled"),
      new Promise((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(settled).toBe("pending");
  });

  it("无 sessionId 的 pending 在任何 scoped rejectAll 下都会被拒", async () => {
    const p = approvals.requestWithId("tc", { tool: "execute", risk: "exec", argsPreview: "" });
    approvals.rejectAll("X");
    await expect(p).resolves.toBe("deny");
  });
});
