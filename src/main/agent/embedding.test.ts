import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// embedText 在 provider==="none" 时短路返回 null，且不触碰网络。
// 其余路径会 fetch embedding 后端；本测试用 stubGlobal 伪造 fetch。
describe("agent/embedding — embedText", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("provider==='none' 时直接返回 null，且不发起任何网络请求", async () => {
    const { embedText } = await import("./embedding");
    const out = await embedText("hello", { provider: "none" } as any);
    expect(out).toBeNull();
    expect((globalThis.fetch as any).mock.calls.length).toBe(0);
  });

  it("ollama 后端正常返回向量", async () => {
    const { embedText } = await import("./embedding");
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
    });
    const vec = await embedText("hi", {
      provider: "ollama",
      model: "nomic",
      baseUrl: "http://localhost:11434",
    } as any);
    expect(vec).toEqual([0.1, 0.2, 0.3]);
  });

  it("ollama 后端异常时返回 null 且不抛错（带 5 分钟冷却）", async () => {
    const { embedText } = await import("./embedding");
    (globalThis.fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));
    let threw = false;
    let out: number[] | null = null;
    try {
      out = await embedText("hi", {
        provider: "ollama",
        model: "nomic",
      } as any);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(out).toBeNull();
  });
});
