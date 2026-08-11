// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("./components/Sidebar", () => ({
  Sidebar: (props: { onSelect: (id: string) => void; onNew: () => void }) => (
    <aside>
      <button aria-label="select-session" onClick={() => props.onSelect("s1")} />
      <button aria-label="new-session" onClick={props.onNew} />
    </aside>
  ),
}));
vi.mock("./components/Chat", () => ({ Chat: () => <div data-testid="chat" /> }));
vi.mock("./components/Settings", () => ({ Settings: () => <div /> }));
vi.mock("./components/Onboarding", () => ({ Onboarding: () => <div /> }));
vi.mock("./components/RightPanel", () => ({
  RightPanel: () => <div data-testid="right-panel" />,
}));
vi.mock("./components/TerminalPanel", () => ({ TerminalPanel: () => <div /> }));
vi.mock("./components/TerminalErrorBoundary", () => ({
  TerminalErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./hooks/useChatEvents", () => ({ useChatEvents: vi.fn() }));
vi.mock("./lib/useTurnWatchdog", () => ({ useTurnWatchdog: () => vi.fn() }));
vi.mock("./lib/theme", () => ({
  applyAppearance: vi.fn(),
  watchSystemTheme: () => vi.fn(),
}));
vi.mock("./i18n", () => ({
  default: { changeLanguage: vi.fn(), t: (key: string) => key },
}));

import { App } from "./App";

const session = {
  id: "s1",
  title: "Existing chat",
  createdAt: 1,
  updatedAt: 1,
  source: "user",
  group: "Default",
  permissionMode: "manual",
};

beforeEach(() => {
  localStorage.clear();
  // Reproduce the bug: the panel was left open in an existing chat.
  localStorage.setItem("dw.right.collapsed", "0");
  Object.defineProperty(window, "deepwork", { configurable: true, value: {
    sessions: {
      list: vi.fn(async () => [session]),
      get: vi.fn(async () => session),
    },
    settings: {
      get: vi.fn(async () => ({
        configuredModels: [],
        onboarded: true,
        language: "en-US",
        showReasoning: true,
        funMode: false,
        permissionMode: "manual",
      })),
    },
    updates: {
      onStatus: vi.fn(() => vi.fn()),
      check: vi.fn(async () => undefined),
    },
    chat: {
      history: vi.fn(async () => ({ timeline: [], todos: [] })),
      status: vi.fn(async () => ({ state: "idle" })),
      cancel: vi.fn(async () => undefined),
    },
    artifacts: { list: vi.fn(async () => []) },
  } });
});

describe("App session-scoped tools", () => {
  it("closes the right panel when starting a new session", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "select-session" }));
    await waitFor(() => expect(screen.getByTestId("right-panel")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "new-session" }));

    expect(screen.queryByTestId("right-panel")).toBeNull();
    expect(localStorage.getItem("dw.right.collapsed")).toBe("1");
  });
});
