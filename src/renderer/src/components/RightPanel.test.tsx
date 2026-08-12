// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RightPanel } from "./RightPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { completed?: number; total?: number }) =>
      values ? `${key}:${values.completed}/${values.total}` : key,
  }),
}));

describe("RightPanel", () => {
  beforeEach(() => {
    Object.defineProperty(window, "deepwork", {
      configurable: true,
      value: { artifacts: { list: vi.fn(), open: vi.fn(), reveal: vi.fn() } },
    });
  });

  afterEach(cleanup);

  it("shows authoritative task progress and exposes collapsible state", () => {
    render(
      <RightPanel
        sessionId="session-1"
        todos={[
          { content: "Inspect", status: "completed" },
          { content: "Implement", status: "in_progress" },
        ]}
        artifacts={[]}
        onRefreshArtifacts={vi.fn()}
      />,
    );

    expect(screen.getByText("rightPanel.progressSummary:1/2")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    const progressButton = screen.getByRole("button", { name: /rightPanel.tasks/ });
    expect(progressButton.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(progressButton);
    expect(progressButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps artifact header actions as separate accessible buttons", () => {
    const refresh = vi.fn();
    render(
      <RightPanel
        sessionId="session-1"
        todos={[]}
        artifacts={[]}
        onRefreshArtifacts={refresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "rightPanel.refresh" }));
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "rightPanel.showInFinder" }).disabled).toBe(true);
  });

  it("opens and reveals the selected session artifact", () => {
    const artifact = {
      name: "report.md", relativePath: "report.md", absolutePath: "/tmp/report.md",
      size: 12, modifiedAt: Date.now(), ext: "md",
    };
    render(<RightPanel sessionId="session-1" todos={[]} artifacts={[artifact]} onRefreshArtifacts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "rightPanel.showInFinder" }));
    expect(window.deepwork.artifacts.reveal).toHaveBeenCalledWith("session-1", "/tmp/report.md");
    fireEvent.click(screen.getByRole("button", { name: "rightPanel.open" }));
    expect(window.deepwork.artifacts.open).toHaveBeenCalledWith("session-1", "/tmp/report.md");
  });

  it("renders the empty artifact state without exposing file actions", () => {
    render(<RightPanel sessionId="session-1" todos={[]} artifacts={[]} onRefreshArtifacts={vi.fn()} />);
    expect(screen.getByText("rightPanel.emptyArtifacts")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "rightPanel.open" })).toBeNull();
  });
});
