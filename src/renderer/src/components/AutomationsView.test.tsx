// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AutomationsView } from "./AutomationsView";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key === "automations.toggleLabel"
        ? `Toggle ${String(options?.title ?? "")}`
        : key,
  }),
}));

const automation = {
  id: "automation-1",
  title: "Morning brief",
  instructions: "Summarize the project",
  scheduleType: "daily" as const,
  scheduleConfig: { time: "09:00" },
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

afterEach(cleanup);

describe("AutomationsView list toggle", () => {
  beforeEach(() => {
    const update = vi.fn(async () => undefined);
    Object.defineProperty(window, "deepwork", {
      configurable: true,
      value: {
        automations: {
          list: vi.fn(async () => [automation]),
          update,
        },
        settings: {
          get: vi.fn(async () => ({ mcpServers: [], configuredModels: [] })),
        },
        skills: { list: vi.fn(async () => []) },
      },
    });
  });

  it("shows the enabled control in the action group and updates the automation", async () => {
    render(<AutomationsView />);

    const toggle = await screen.findByRole("switch", { name: "Toggle Morning brief" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.closest(".auto-actions")).not.toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Morning brief" })).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await waitFor(() =>
      expect(window.deepwork.automations.update).toHaveBeenCalledWith("automation-1", {
        enabled: false,
      }),
    );
  });

  it("uses a sliding switch in the editor", async () => {
    render(<AutomationsView />);

    await screen.findByText("Morning brief");
    fireEvent.click(screen.getByRole("button", { name: "common.edit" }));

    const formToggle = screen.getByRole("switch", {
      name: "automations.formToggleLabel",
    });
    expect(formToggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("checkbox")).toBeNull();

    fireEvent.click(formToggle);
    expect(formToggle.getAttribute("aria-checked")).toBe("false");
  });
});
