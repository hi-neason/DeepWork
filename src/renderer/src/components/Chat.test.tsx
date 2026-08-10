// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { Chat, buildSegments } from "./Chat";
import type { ChatState } from "../App";

// The render layer does not depend on real i18n: t() returns the key directly,
// making component logic easy to assert. Trans renders the i18nKey text and
// injects values into component slots; the minimal stub outputs i18nKey +
// values so assertions can match the tool name without [object Object].
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: {} }),
  initReactI18next: { type: "3rdParty", init: () => {} },
  Trans: ({ i18nKey, values }: any) =>
    React.createElement("span", null, `${i18nKey} ${values?.name ?? ""}`),
}));
// Make renderer/src/i18n.ts's `i18n.use(initReactI18next).init(...)` a no-op in tests.
// prettyToolName calls i18n.exists/t; provide a minimal stub: t returns the key
// itself, exists always returns false.
vi.mock("i18next", () => ({
  default: {
    use: () => ({ init: () => {} }),
    t: (k: string) => k,
    exists: () => false,
  },
}));

function makeProps(overrides: Record<string, any> = {}) {
  return {
    sessionId: "s1",
    sessionTitle: "t",
    chat: { timeline: [], tools: {}, toolStart: {}, streaming: false },
    todos: [],
    artifacts: [],
    updateStatus: { state: "idle" } as any,
    workspaceDir: undefined,
    sessionModel: undefined,
    enabledModels: [{ id: "m1", label: "M1" }] as any,
    onSend: vi.fn(),
    defaultMode: "manual",
    onCancel: vi.fn(),
    onRegenerate: vi.fn(),
    onSetModel: vi.fn(),
    onRefreshModels: vi.fn(),
    onAddModel: vi.fn(),
    onInstallUpdate: vi.fn(),
    rightPanelOpen: false,
    onToggleRightPanel: vi.fn(),
    terminalOpen: false,
    onToggleTerminal: vi.fn(),
    approval: null,
    onRespondApproval: vi.fn(),
    onJumpToArtifact: vi.fn(),
    ...overrides,
  } as any;
}

beforeEach(() => {
  // jsdom does not implement scrollTo
  Element.prototype.scrollTo = vi.fn();
  (window as any).deepwork = {
    skills: { list: vi.fn(() => Promise.resolve([])) },
    sessions: { recentFolders: vi.fn(() => Promise.resolve([])) },
    settings: { pickDirectory: vi.fn(() => Promise.resolve(null)) },
    chat: { onAnyEvent: vi.fn(), send: vi.fn(), cancel: vi.fn() },
    updates: { onStatus: vi.fn() },
    terminal: { onData: vi.fn() },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Chat component (render layer)", () => {
  it("mounts and renders the composer textarea (smoke)", () => {
    const { container } = render(<Chat {...makeProps()} />);
    const ta = container.querySelector("textarea");
    expect(ta).toBeTruthy();
  });

  it("typing text and clicking send calls onSend, passing through text/model/default mode", () => {
    const onSend = vi.fn();
    const { container } = render(<Chat {...makeProps({ onSend })} />);
    const ta = container.querySelector("textarea")!;
    fireEvent.change(ta, { target: { value: "hello world" } });

    const sendBtn = screen.getByRole("button", { name: "chat.send" });
    fireEvent.click(sendBtn);

    expect(onSend).toHaveBeenCalledTimes(1);
    const args = onSend.mock.calls[0];
    expect(args[0]).toBe("hello world"); // text
    expect(args[3]).toBe("m1"); // activeModel comes from enabledModels[0]
    expect(args[4]).toBeUndefined(); // no per-send mode selected → passes through undefined
  });

  it("per-send mode defaults to undefined (mode passthrough baseline)", () => {
    const onSend = vi.fn();
    const { container } = render(<Chat {...makeProps({ onSend })} />);
    const ta = container.querySelector("textarea")!;
    fireEvent.change(ta, { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "chat.send" }));
    expect(onSend.mock.calls[0][4]).toBeUndefined();
  });

  it("renders attachments that belong to a user message", () => {
    render(<Chat {...makeProps({
      chat: {
        timeline: [{
          kind: "msg",
          role: "user",
          content: "see attached",
          attachments: [{
            id: "att-1",
            name: "screen.png",
            mimeType: "image/png",
            size: 2048,
            dataUrl: "data:image/png;base64,abc",
            kind: "image",
          }],
        }],
        tools: {},
        toolStart: {},
        streaming: false,
      },
    })} />);

    expect(screen.getByText("see attached")).toBeTruthy();
    expect(screen.getByText("screen.png")).toBeTruthy();
    expect(screen.getByAltText("screen.png")).toBeTruthy();
  });

  it("opens and closes a full-size preview for image attachments", () => {
    render(<Chat {...makeProps({
      chat: {
        timeline: [{
          kind: "msg",
          role: "user",
          content: "see attached",
          attachments: [{
            id: "att-1",
            name: "screen.png",
            mimeType: "image/png",
            size: 2048,
            dataUrl: "data:image/png;base64,abc",
            kind: "image",
          }],
        }],
        tools: {},
        toolStart: {},
        streaming: false,
      },
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "screen.png" }));
    expect(screen.getByRole("dialog", { name: "screen.png" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "screen.png" })).toBeNull();
  });

  // C2 fix: render with <Trans> so the tool name appears as plain text instead of [object Object].
  it("chat.needApproval renders the tool name instead of [object Object]", () => {
    const props = makeProps({
      approval: {
        id: "a1",
        name: "execute",
        risk: "exec",
        argsPreview: "",
      } as any,
    });
    render(<Chat {...props} />);
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
    // The tool name (execute's localized display) should appear in the approval banner
    expect(document.querySelector(".approval-banner-title")?.textContent).toMatch(
      /execute|执行/,
    );
  });

  // M-render③: every segment must carry a stable id so that on streaming rebuild
  // ActivityGroup reuses the same node and the collapsed state is not lost due to
  // array-index shifting.
  it("every segment has a stable id, and appending thinking does not change existing segment ids", () => {
    const base: ChatState = {
      timeline: [
        { kind: "msg", role: "user", content: "hi" },
        { kind: "reasoning", text: "a", phase: "tool" },
      ],
      tools: {},
      toolStart: {},
      streaming: true,
    };
    const first = buildSegments(base);
    expect(first.every((s) => typeof s.id === "string" && s.id.length > 0)).toBe(true);

    // Append new text to the same reasoning block (a typical streaming-delta scenario)
    const grown: ChatState = {
      ...base,
      timeline: [
        { kind: "msg", role: "user", content: "hi" },
        { kind: "reasoning", text: "ab", phase: "tool" },
      ],
    };
    const second = buildSegments(grown);
    // Segment count stays the same and each position's id is consistent
    // (no shift due to reordering)
    expect(second.length).toBe(first.length);
    second.forEach((s, i) => {
      expect(s.id).toBe(first[i].id);
    });
  });

  // H: when onSend throws (synchronous throw or rejected promise), submit must
  // swallow the rejection so no unhandled rejection bubbles up; the actual
  // streaming/error reset is handled by the parent component's (App) set_error
  // and the useTurnWatchdog watchdog.
  it("submit does not produce an unhandled rejection when onSend throws (H submit safety net)", async () => {
    const onSend = vi.fn(() => Promise.reject(new Error("boom")));
    const { container } = render(<Chat {...makeProps({ onSend })} />);
    const ta = container.querySelector("textarea")!;
    fireEvent.change(ta, { target: { value: "hi" } });

    // Capture unhandled Promise rejections
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent): void => {
      unhandled.push(e.reason);
    };
    window.addEventListener("unhandledrejection", onUnhandled);

    fireEvent.click(screen.getByRole("button", { name: "chat.send" }));
    // Let the rejected promise propagate through the microtask queue
    await Promise.resolve();
    await Promise.resolve();

    window.removeEventListener("unhandledrejection", onUnhandled);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(unhandled).toHaveLength(0);
  });
});
