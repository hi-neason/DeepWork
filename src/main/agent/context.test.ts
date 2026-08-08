import { describe, it, expect } from "vitest";
import { extractLastUserQuery } from "./context";

describe("agent/context — extractLastUserQuery (C-T4 根因)", () => {
  it("普通对象带 role:'user' 能提取最后一条用户文本", () => {
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "第一条" },
      { role: "assistant", content: "回复" },
      { role: "user", content: "第二条" },
    ];
    expect(extractLastUserQuery(msgs as any)).toBe("第二条");
  });

  it("无用户消息时返回空串", () => {
    expect(extractLastUserQuery([{ role: "system", content: "x" }] as any)).toBe("");
  });

  it("LangChain BaseMessage 用 type/human 标记, 能提取最后一条 human 文本 (C-A2 修复前按 role 匹配永远取不到 → workspace 记忆永不注入)", () => {
    const lcMsgs = [
      { type: "system", content: "sys" },
      { type: "human", content: "我是用户" },
    ];
    expect(extractLastUserQuery(lcMsgs as any)).toBe("我是用户");
  });

  it("BaseMessage 实例 (getType()==='human') 也能提取, 且 content 为 blocks[] 时取文本", () => {
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
