import { describe, it, expect } from "vitest";
import { extractLastUserQuery } from "./context";

describe("agent/context - extractLastUserQuery (C-T4 root cause)", () => {
  it("extracts the last user text from plain objects with role:'user'", () => {
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "第一条" },
      { role: "assistant", content: "回复" },
      { role: "user", content: "第二条" },
    ];
    expect(extractLastUserQuery(msgs as any)).toBe("第二条");
  });

  it("returns an empty string when there are no user messages", () => {
    expect(extractLastUserQuery([{ role: "system", content: "x" }] as any)).toBe("");
  });

  it("extracts the last human text from LangChain BaseMessages marked via type/human (before the C-A2 fix matching by role never found it, so workspace memory was never injected)", () => {
    const lcMsgs = [
      { type: "system", content: "sys" },
      { type: "human", content: "我是用户" },
    ];
    expect(extractLastUserQuery(lcMsgs as any)).toBe("我是用户");
  });

  it("also extracts from BaseMessage instances (getType()==='human'), and reads text when content is blocks[]", () => {
    const humanMsg = {
      getType: () => "human",
      content: [
        { type: "text", text: "先看 " },
        { type: "text", text: "第二块" },
      ],
    };
    const msgs = [
      { getType: () => "system", content: "sys" },
      humanMsg,
    ];
    expect(extractLastUserQuery(msgs as any)).toBe("先看 第二块");
  });
});
