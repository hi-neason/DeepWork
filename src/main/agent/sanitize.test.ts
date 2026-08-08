import { describe, it, expect } from "vitest";
import { resolveThreadIdForSanitize, sanitizeMessage } from "./sanitize";

describe("agent/sanitize — resolveThreadIdForSanitize (C-A1 修复)", () => {
  it("从 request.runtime.configurable.thread_id 读取（主路径，修复前此处返回 undefined）", () => {
    expect(
      resolveThreadIdForSanitize({ runtime: { configurable: { thread_id: "t2" } } }),
    ).toBe("t2");
  });

  it("兼容回退 request.config.configurable.thread_id（旧 langchain 形态）", () => {
    expect(
      resolveThreadIdForSanitize({ config: { configurable: { thread_id: "t1" } } }),
    ).toBe("t1");
  });

  it("runtime 优先于 config（两者并存时取 runtime）", () => {
    expect(
      resolveThreadIdForSanitize({
        runtime: { configurable: { thread_id: "rt" } },
        config: { configurable: { thread_id: "cfg" } },
      }),
    ).toBe("rt");
  });

  it("无 configurable 时返回 undefined", () => {
    expect(resolveThreadIdForSanitize({})).toBeUndefined();
    expect(resolveThreadIdForSanitize(undefined)).toBeUndefined();
  });
});

describe("agent/sanitize — sanitizeMessage (C-A3 原型保护)", () => {
  it("非数组 content 直接原样返回", () => {
    const msg = { getType: () => "human", content: "纯文本" };
    expect(sanitizeMessage(msg)).toBe(msg);
  });

  it("无非法 block 时不改原型 (仍为同一构造器实例)", () => {
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

  it("清洗数组 content 后保留 BaseMessage 原型 (C-A3 修复前会丢失 getType)", () => {
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
      { type: "input_json_delta", text: "" }, // 非法 block，应被剔除
    ]);
    const out = sanitizeMessage(msg);
    expect(out).toBeInstanceOf(FakeMsg);
    expect(typeof out.getType).toBe("function");
    expect(out.getType()).toBe("human");
    expect(out.content).toEqual([{ type: "text", text: "保留" }]);
  });
});
