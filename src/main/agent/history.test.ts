import { describe, expect, it } from "vitest";
import { projectHistory } from "./history";

describe("projectHistory", () => {
  it("reconstructs messages, tool output, reasoning, and todos", () => {
    const result = projectHistory([
      { _getType: () => "human", content: "Plan it" },
      { _getType: () => "ai", content: "Working", additional_kwargs: { reasoning: "Think" }, tool_calls: [{ id: "t1", name: "write_todos", args: { todos: [{ content: "Implement", status: "in_progress" }] } }] },
      { _getType: () => "tool", tool_call_id: "t1", content: "done" },
    ], (message) => String(message.additional_kwargs?.reasoning ?? ""));

    expect(result.todos).toEqual([{ content: "Implement", status: "in_progress" }]);
    expect(result.timeline).toEqual(expect.arrayContaining([
      { kind: "msg", role: "user", content: "Plan it" },
      expect.objectContaining({ kind: "tool", id: "t1", outputPreview: "done" }),
    ]));
  });
});
