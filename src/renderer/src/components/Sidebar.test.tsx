// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import type { Session } from "../../../shared/types";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const sessions: Session[] = [
  { id: "s1", title: "Alpha task", group: "Default", source: "user", createdAt: 1, updatedAt: 3, permissionMode: "manual" },
  { id: "s2", title: "Beta task", group: "Project", source: "user", createdAt: 2, updatedAt: 2, permissionMode: "manual" },
];

function renderSidebar(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const props: React.ComponentProps<typeof Sidebar> = {
    sessions, activeId: null, activeView: "chat", onNew: vi.fn(), onSelect: vi.fn(),
    onDelete: vi.fn(), onRename: vi.fn(), onOpenView: vi.fn(), onMoveToGroup: vi.fn(),
    onRenameGroup: vi.fn(), onDeleteGroup: vi.fn(), onCreateGroup: vi.fn(), ...overrides,
  };
  render(<Sidebar {...props} />);
  return props;
}

describe("Sidebar", () => {
  beforeEach(() => {
    Object.defineProperty(window, "deepwork", { configurable: true, value: { automations: {
      listWithRuns: vi.fn(async () => [{
        id: "a1", title: "Daily report", instructions: "run", enabled: true,
        scheduleType: "daily", scheduleConfig: { time: "09:00" }, createdAt: 1, updatedAt: 1,
        runs: [{ id: "r1", automationId: "a1", startedAt: 1, status: "success", sessionId: "run-session" }],
      }]),
      deleteRun: vi.fn(async () => undefined), deleteRuns: vi.fn(async () => undefined),
    } } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("creates tasks, selects, filters, deletes, and opens settings", () => {
    const props = renderSidebar();
    fireEvent.click(screen.getByText("sidebar.newTask"));
    expect(props.onNew).toHaveBeenCalled();
    expect(props.onOpenView).toHaveBeenCalledWith("chat");
    fireEvent.click(screen.getByText("Alpha task"));
    expect(props.onSelect).toHaveBeenCalledWith("s1");
    fireEvent.change(screen.getByPlaceholderText("sidebar.searchTasks"), { target: { value: "beta" } });
    expect(screen.queryByText("Alpha task")).toBeNull();
    expect(screen.getByText("Beta task")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "sidebar.delete Beta task" }));
    expect(props.onDelete).toHaveBeenCalledWith("s2");
    fireEvent.click(screen.getByText("sidebar.settings"));
    expect(props.onOpenView).toHaveBeenCalledWith("settings");
  });

  it("renames a session from its context menu", () => {
    const props = renderSidebar();
    fireEvent.contextMenu(screen.getByText("Alpha task"));
    fireEvent.click(screen.getByText("sidebar.rename"));
    const input = screen.getByDisplayValue("Alpha task");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRename).toHaveBeenCalledWith("s1", "Renamed");
  });

  it("loads automation runs, opens a run, and handles deletion failures", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const props = renderSidebar();
    fireEvent.click(screen.getByText("sidebar.automations"));
    expect(await screen.findByText("Daily report")).toBeTruthy();
    fireEvent.click(screen.getByText(/01-01/));
    expect(props.onSelect).toHaveBeenCalledWith("run-session");

    vi.mocked(window.deepwork.automations.deleteRun).mockRejectedValueOnce(new Error("locked"));
    fireEvent.click(screen.getByTitle("sidebar.deleteRun"));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("locked"));
  });

  it("shows empty and filtered automation states", async () => {
    vi.mocked(window.deepwork.automations.listWithRuns).mockResolvedValue([]);
    renderSidebar();
    fireEvent.click(screen.getByText("sidebar.automations"));
    expect(await screen.findByText("sidebar.noAutomations")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("sidebar.searchAutomations"), { target: { value: "none" } });
    expect(screen.getByText("sidebar.noAutomationMatches")).toBeTruthy();
  });
});
