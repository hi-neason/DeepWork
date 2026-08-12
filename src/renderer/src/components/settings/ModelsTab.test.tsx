// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelsTab } from "./ModelsTab";
import type { Settings } from "../../../../shared/types";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const settings = {
  model: { provider: "openai", model: "gpt-test", workspaceDir: "" },
  configuredModels: [
    { id: "openai:gpt-test", provider: "openai", enabled: true, isDefault: true },
    { id: "ollama:local-test", provider: "ollama", enabled: true },
  ],
} as Settings;

describe("ModelsTab", () => {
  beforeEach(() => {
    Object.defineProperty(window, "deepwork", { configurable: true, value: {
      settings: { getKey: vi.fn(async () => "stored-secret"), setKey: vi.fn(async () => undefined) },
      models: { verify: vi.fn(async () => ({ ok: true, message: "connected" })) },
    } });
  });
  afterEach(cleanup);

  it("toggles and selects configured models", () => {
    const onSettingsChange = vi.fn();
    render(<ModelsTab settings={settings} onChange={vi.fn()} onSettingsChange={onSettingsChange} />);

    fireEvent.click(screen.getAllByRole("switch")[1]);
    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({
      configuredModels: expect.arrayContaining([
        expect.objectContaining({ id: "ollama:local-test", enabled: false }),
      ]),
    }));
    fireEvent.click(screen.getByText("settings.models.setDefault"));
    expect(onSettingsChange).toHaveBeenLastCalledWith(expect.objectContaining({
      model: expect.objectContaining({ provider: "ollama", model: "local-test" }),
    }));
  });

  it("keeps a stored API key masked on focus and does not overwrite it on blank save", async () => {
    const onSettingsChange = vi.fn();
    render(<ModelsTab settings={settings} onChange={vi.fn()} onSettingsChange={onSettingsChange} />);
    fireEvent.click(screen.getAllByTitle("settings.models.edit")[0]);

    const keyInput = await screen.findByDisplayValue("••••••••••••••••");
    fireEvent.focus(keyInput);
    expect((keyInput as HTMLInputElement).value).toBe("••••••••••••••••");
    fireEvent.click(screen.getByText("common.save"));

    expect(window.deepwork.settings.setKey).not.toHaveBeenCalled();
    expect(onSettingsChange).toHaveBeenCalled();
  });

  it("saves a replacement key, verifies it, and clears it explicitly", async () => {
    render(<ModelsTab settings={settings} onChange={vi.fn()} onSettingsChange={vi.fn()} />);
    fireEvent.click(screen.getAllByTitle("settings.models.edit")[0]);
    const keyInput = await screen.findByDisplayValue("••••••••••••••••");
    fireEvent.change(keyInput, { target: { value: "new-secret" } });
    fireEvent.click(screen.getByText("settings.models.testConnection"));
    await waitFor(() => expect(window.deepwork.settings.setKey).toHaveBeenCalledWith("openai", "new-secret"));
    expect(window.deepwork.models.verify).toHaveBeenCalled();

    cleanup();
    render(<ModelsTab settings={settings} onChange={vi.fn()} onSettingsChange={vi.fn()} />);
    fireEvent.click(screen.getAllByTitle("settings.models.edit")[0]);
    await screen.findByDisplayValue("••••••••••••••••");
    fireEvent.click(screen.getByTitle("settings.models.clearSavedKey"));
    expect(window.deepwork.settings.setKey).toHaveBeenCalledWith("openai", "");
  });
});
