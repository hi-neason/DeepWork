// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeneralTab } from "./GeneralTab";
import type { Settings } from "../../../../shared/types";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const settings = {
  theme: "dark", language: "en-US", fontScale: 1, includeAgentsMd: true,
  includeClaudeMd: true, openAtLogin: false, trayEnabled: true, keepAwake: true,
  showReasoning: true, funMode: false, logEnabled: false,
  model: { provider: "openai", model: "gpt", workspaceDir: "" },
} as Settings;

describe("GeneralTab", () => {
  beforeEach(() => {
    Object.defineProperty(window, "deepwork", { configurable: true, value: {
      settings: { pickDirectory: vi.fn(async () => "/tmp/project") },
    } });
  });
  afterEach(cleanup);

  it("updates appearance, numeric boundaries, toggles, and manual workspace", () => {
    const onChange = vi.fn();
    const onModelChange = vi.fn();
    render(<GeneralTab settings={settings} onChange={onChange} onModelChange={onModelChange} />);
    fireEvent.click(screen.getByText("settings.general.themeLight"));
    expect(onChange).toHaveBeenCalledWith({ theme: "light" });
    fireEvent.change(screen.getByRole("slider"), { target: { value: "1.3" } });
    expect(onChange).toHaveBeenCalledWith({ fontScale: 1.3 });
    fireEvent.change(screen.getByPlaceholderText("settings.general.workspacePlaceholder"), {
      target: { value: "/manual" },
    });
    expect(onModelChange).toHaveBeenCalledWith({ workspaceDir: "/manual" });
    fireEvent.click(screen.getByRole("switch", { name: "settings.general.logEnabled" }));
    expect(onChange).toHaveBeenCalledWith({ logEnabled: true });
  });

  it("uses a picked directory and ignores picker cancellation", async () => {
    const onModelChange = vi.fn();
    render(<GeneralTab settings={settings} onChange={vi.fn()} onModelChange={onModelChange} />);
    fireEvent.click(screen.getByText("common.browse"));
    await waitFor(() => expect(onModelChange).toHaveBeenCalledWith({ workspaceDir: "/tmp/project" }));
    vi.mocked(window.deepwork.settings.pickDirectory).mockResolvedValueOnce(null);
    fireEvent.click(screen.getByText("common.browse"));
    await waitFor(() => expect(window.deepwork.settings.pickDirectory).toHaveBeenCalledTimes(2));
    expect(onModelChange).toHaveBeenCalledTimes(1);
  });
});
