import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// embedText short-circuits and returns null when provider==="none", without
// touching the network. Other paths fetch the embedding backend; this test
// fakes fetch with stubGlobal.
describe("agent/embedding - embedText", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns null directly and makes no network request when provider==='none'", async () => {
    const { embedText } = await import("./embedding");
    const out = await embedText("hello", { provider: "none" } as any);
    expect(out).toBeNull();
    expect((globalThis.fetch as any).mock.calls.length).toBe(0);
  });

  it("the ollama backend returns a vector normally", async () => {
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

  it("returns null without throwing when the ollama backend errors (with a 5-minute cooldown)", async () => {
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
