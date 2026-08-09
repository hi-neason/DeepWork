import { describe, it, expect } from "vitest";
import { resolveThreadIdForSanitize, sanitizeMessage } from "./sanitize";

describe("agent/sanitize - resolveThreadIdForSanitize (C-A1 fix)", () => {
  it("reads from request.runtime.configurable.thread_id (main path; before the fix this returned undefined)", () => {
    expect(
      resolveThreadIdForSanitize({ runtime: { configurable: { thread_id: "t2" } } }),
    ).toBe("t2");
  });

  it("falls back compatibly to request.config.configurable.thread_id (legacy langchain form)", () => {
    expect(
      resolveThreadIdForSanitize({ config: { configurable: { thread_id: "t1" } } }),
    ).toBe("t1");
  });

  it("runtime takes precedence over config (when both exist, runtime wins)", () => {
    expect(
      resolveThreadIdForSanitize({
        runtime: { configurable: { thread_id: "rt" } },
        config: { configurable: { thread_id: "cfg" } },
      }),
    ).toBe("rt");
  });

  it("returns undefined when there is no configurable", () => {
    expect(resolveThreadIdForSanitize({})).toBeUndefined();
    expect(resolveThreadIdForSanitize(undefined)).toBeUndefined();
  });
});

describe("agent/sanitize - sanitizeMessage (C-A3 prototype protection)", () => {
  it("non-array content is returned as-is", () => {
    const msg = { getType: () => "human", content: "纯文本" };
    expect(sanitizeMessage(msg)).toBe(msg);
  });

  it("does not alter the prototype when there are no invalid blocks (still the same constructor instance)", () => {
    class FakeMsg {
      content: unknown;
      constructor(c: unknown) {
        this.content = c;
      }
      getType() {
        return "human";
      }
    }
    const msg = new FakeMsg([{ type: "text", text: "hi" }]);
    const out = sanitizeMessage(msg);
    expect(out).toBe(msg);
    expect(out).toBeInstanceOf(FakeMsg);
  });

  it("preserves the BaseMessage prototype after cleaning array content (before the C-A3 fix getType was lost)", () => {
    class FakeMsg {
      content: unknown;
      constructor(c: unknown) {
        this.content = c;
      }
      getType() {
        return "human";
      }
    }
    const msg = new FakeMsg([
      { type: "text", text: "保留" },
      { type: "input_json_delta", text: "" }, // invalid block, should be removed
    ]);
    const out = sanitizeMessage(msg);
    expect(out).toBeInstanceOf(FakeMsg);
    expect(typeof out.getType).toBe("function");
    expect(out.getType()).toBe("human");
    expect(out.content).toEqual([{ type: "text", text: "保留" }]);
  });
});
