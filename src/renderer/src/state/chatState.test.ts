import { describe, expect, it } from "vitest";
import { chatReducer, initialChatState } from "./chatState";

describe("chatReducer", () => {
  it("uses the authoritative turn state to control streaming", () => {
    const running = chatReducer(initialChatState, {
      type: "event",
      event: { type: "turn_state", status: { state: "waiting_approval", turnId: "t1" } },
    });
    const completed = chatReducer(running, {
      type: "event",
      event: { type: "turn_state", status: { state: "completed", turnId: "t1" } },
    });

    expect(running.streaming).toBe(true);
    expect(completed.streaming).toBe(false);
  });

  it("appends streamed text to the current assistant reply", () => {
    const withUser = chatReducer(initialChatState, { type: "user", text: "Hello" });
    const first = chatReducer(withUser, { type: "event", event: { type: "message_delta", text: "Hi" } });
    const second = chatReducer(first, { type: "event", event: { type: "message_delta", text: " there" } });

    expect(second.timeline).toEqual([
      { kind: "msg", role: "user", content: "Hello" },
      { kind: "msg", role: "assistant", content: "Hi there" },
    ]);
  });

  it("keeps user attachments on the optimistic timeline entry", () => {
    const attachment = {
      id: "a1",
      name: "diagram.png",
      mimeType: "image/png",
      size: 1234,
      dataUrl: "data:image/png;base64,abc",
      kind: "image" as const,
    };
    const state = chatReducer(initialChatState, {
      type: "user",
      text: "please inspect this",
      attachments: [attachment],
    });

    expect(state.timeline[0]).toMatchObject({
      kind: "msg",
      role: "user",
      content: "please inspect this",
      attachments: [attachment],
    });
  });

  it("records a tool call once and attaches its completion result", () => {
    const started = chatReducer(initialChatState, {
      type: "event",
      event: { type: "tool_call_started", id: "tool-1", name: "read_file", argsPreview: "a.txt" },
    });
    const finished = chatReducer(started, {
      type: "event",
      event: { type: "tool_call_finished", id: "tool-1", name: "read_file", outputPreview: "contents" },
    });

    expect(finished.timeline).toEqual([{ kind: "tool", id: "tool-1" }]);
    expect(finished.tools["tool-1"]).toMatchObject({ status: "done", outputPreview: "contents" });
  });
});
