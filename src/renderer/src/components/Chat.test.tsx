// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { Chat, buildSegments } from "./Chat";
import type { ChatState } from "../App";

// 渲染层不依赖真实 i18n：t() 直接返回 key，便于断言组件逻辑。
// Trans 渲染 i18nKey 文本并把 values 注入 components 占位；最小桩直接输出
// i18nKey + values，使断言能命中工具名且不产生 [object Object]。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: {} }),
  initReactI18next: { type: "3rdParty", init: () => {} },
  Trans: ({ i18nKey, values }: any) =>
    React.createElement("span", null, `${i18nKey} ${values?.name ?? ""}`),
}));
// 让 renderer/src/i18n.ts 的 `i18n.use(initReactI18next).init(...)` 在测试里变成 no-op。
// prettyToolName 会调用 i18n.exists/t，这里给出最小桩：t 返回 key 本身，exists 恒 false。
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
  // jsdom 未实现 scrollTo
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

describe("Chat 组件（渲染层）", () => {
  it("能挂载并渲染 composer 输入框（smoke）", () => {
    const { container } = render(<Chat {...makeProps()} />);
    const ta = container.querySelector("textarea");
    expect(ta).toBeTruthy();
  });

  it("输入文字并点击发送会调用 onSend，且透传文本/模型/默认 mode", () => {
    const onSend = vi.fn();
    const { container } = render(<Chat {...makeProps({ onSend })} />);
    const ta = container.querySelector("textarea")!;
    fireEvent.change(ta, { target: { value: "hello world" } });

    const sendBtn = screen.getByRole("button", { name: "chat.send" });
    fireEvent.click(sendBtn);

    expect(onSend).toHaveBeenCalledTimes(1);
    const args = onSend.mock.calls[0];
    expect(args[0]).toBe("hello world"); // 文本
    expect(args[3]).toBe("m1"); // activeModel 取自 enabledModels[0]
    expect(args[4]).toBeUndefined(); // 未选 per-send mode → 透传 undefined
  });

  it("默认情况下 per-send mode 为 undefined（mode 透传基线）", () => {
    const onSend = vi.fn();
    const { container } = render(<Chat {...makeProps({ onSend })} />);
    const ta = container.querySelector("textarea")!;
    fireEvent.change(ta, { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "chat.send" }));
    expect(onSend.mock.calls[0][4]).toBeUndefined();
  });

  // C2 修复：用 <Trans> 渲染，工具名以纯文本出现，不再 [object Object]。
  it("chat.needApproval 渲染出工具名而非 [object Object]", () => {
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
    // 工具名（execute 的本地化展示）应出现在授权横幅里
    expect(document.querySelector(".approval-banner-title")?.textContent).toMatch(
      /execute|执行/,
    );
  });

  // M-渲染③：Segment 必须带稳定 id，使流式重建时 ActivityGroup 复用同一节点，
  // 折叠态不会因数组下标错位而丢失。
  it("每个 segment 都有稳定 id，且追加 thinking 不改变既有 segment 的 id", () => {
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

    // 同一个 reasoning 块追加新文本（流式 delta 的典型场景）
    const grown: ChatState = {
      ...base,
      timeline: [
        { kind: "msg", role: "user", content: "hi" },
        { kind: "reasoning", text: "ab", phase: "tool" },
      ],
    };
    const second = buildSegments(grown);
    // 段数不变，且每个位置的 id 保持一致（不会因为重排而错位）
    expect(second.length).toBe(first.length);
    second.forEach((s, i) => {
      expect(s.id).toBe(first[i].id);
    });
  });

  // H：onSend 抛错（同步 throw 或 rejected promise）时，submit 必须吞掉 rejection，
  // 不能冒出 unhandled rejection；真正的 streaming/error 复位由父组件（App）的
  // set_error 与 useTurnWatchdog 看门狗负责。
  it("onSend 抛错时 submit 不产生 unhandled rejection（H 提交兜底）", async () => {
    const onSend = vi.fn(() => Promise.reject(new Error("boom")));
    const { container } = render(<Chat {...makeProps({ onSend })} />);
    const ta = container.querySelector("textarea")!;
    fireEvent.change(ta, { target: { value: "hi" } });

    // 捕获未处理的 Promise rejection
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent): void => {
      unhandled.push(e.reason);
    };
    window.addEventListener("unhandledrejection", onUnhandled);

    fireEvent.click(screen.getByRole("button", { name: "chat.send" }));
    // 等 rejected promise 穿透 microtask 队列
    await Promise.resolve();
    await Promise.resolve();

    window.removeEventListener("unhandledrejection", onUnhandled);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(unhandled).toHaveLength(0);
  });
});
