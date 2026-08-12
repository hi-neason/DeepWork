// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "./Settings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("./settings/GeneralTab", () => ({
  GeneralTab: ({ onChange }: { onChange: (patch: { theme: string }) => void }) => (
    <button onClick={() => onChange({ theme: "dark" })}>change-general</button>
  ),
}));
vi.mock("./settings/ModelsTab", () => ({ ModelsTab: () => <div>models-panel</div> }));
vi.mock("./settings/MemoryTab", () => ({ MemoryTab: () => <div>memory-panel</div> }));
vi.mock("./settings/AboutTab", () => ({ AboutTab: () => <div>about-panel</div> }));
vi.mock("./Connectors", () => ({ Connectors: () => <div>connectors-panel</div> }));
vi.mock("./AutomationsView", () => ({ AutomationsView: () => <div>automations-panel</div> }));
vi.mock("./SkillsView", () => ({ SkillsView: () => <div>skills-panel</div> }));

describe("Settings accessibility", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    Object.defineProperty(window, "deepwork", {
      configurable: true,
      value: {
        settings: {
          get: vi.fn(async () => ({ theme: "light", fontScale: 1, language: "en-US", model: {} })),
          save: vi.fn(),
          applySystem: vi.fn(),
          rebuildAgent: vi.fn(),
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("connects vertical tabs to the active settings panel", async () => {
    render(<Settings onClose={vi.fn()} />);

    const tablist = await screen.findByRole("tablist");
    expect(tablist.getAttribute("aria-orientation")).toBe("vertical");

    const general = screen.getByRole("tab", { name: "settings.tabs.general" });
    const models = screen.getByRole("tab", { name: "settings.tabs.models" });
    expect(general.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("settings-tab-general");

    fireEvent.click(models);
    expect(models.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("settings-tab-models");
    expect(screen.getByText("models-panel")).toBeTruthy();
  });

  it("labels the close control and announces automatic saving", async () => {
    render(<Settings onClose={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "settings.close" })).toBeTruthy();
    expect(screen.getByText("settings.autoSave").getAttribute("aria-live")).toBe("polite");
  });

  it("debounces persistence and applies runtime changes", async () => {
    vi.useFakeTimers();
    const onSaved = vi.fn();
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    await vi.waitFor(() => expect(screen.getByText("change-general")).toBeTruthy());
    fireEvent.click(screen.getByText("change-general"));
    expect(window.deepwork.settings.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(window.deepwork.settings.save).toHaveBeenCalledWith(expect.objectContaining({ theme: "dark" })));
    expect(window.deepwork.settings.applySystem).toHaveBeenCalled();
    expect(window.deepwork.settings.rebuildAgent).toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
  });

  it("reloads persisted settings when auto-save fails", async () => {
    vi.useFakeTimers();
    vi.mocked(window.deepwork.settings.save).mockRejectedValueOnce(new Error("denied"));
    render(<Settings onClose={vi.fn()} />);
    await vi.waitFor(() => expect(screen.getByText("change-general")).toBeTruthy());
    fireEvent.click(screen.getByText("change-general"));
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(window.deepwork.settings.get).toHaveBeenCalledTimes(2));
    expect(window.deepwork.settings.applySystem).not.toHaveBeenCalled();
  });
});
