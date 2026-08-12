// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Onboarding } from "./Onboarding";
import type { Settings } from "../../../shared/types";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const settings = { model: { provider: "openai", model: "gpt-4.1", workspaceDir: "" }, onboarded: false } as Settings;

describe("Onboarding", () => {
  beforeEach(() => {
    Object.defineProperty(window, "deepwork", { configurable: true, value: {
      settings: {
        setKey: vi.fn(async () => undefined), save: vi.fn(async () => undefined),
        rebuildAgent: vi.fn(async () => undefined), pickDirectory: vi.fn(async () => "/tmp/work"),
      },
      models: { verify: vi.fn(async () => ({ ok: true, message: "ok" })) },
    } });
  });
  afterEach(cleanup);

  it("verifies credentials and completes setup with the picked workspace", async () => {
    const onDone = vi.fn();
    render(<Onboarding settings={settings} onDone={onDone} />);
    fireEvent.change(screen.getByPlaceholderText("sk-..."), { target: { value: "secret" } });
    fireEvent.click(screen.getByText("common.browse"));
    await waitFor(() => expect(screen.getByDisplayValue("/tmp/work")).toBeTruthy());
    fireEvent.click(screen.getByText("common.test"));
    await waitFor(() => expect(window.deepwork.models.verify).toHaveBeenCalled());
    expect(window.deepwork.settings.setKey).toHaveBeenCalledWith("openai", "secret");
    fireEvent.click(screen.getByText("onboarding.continue"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(window.deepwork.settings.save).toHaveBeenCalledWith(expect.objectContaining({
      onboarded: true, model: expect.objectContaining({ workspaceDir: "/tmp/work" }),
    }));
  });

  it("shows persistence failures and does not finish", async () => {
    vi.mocked(window.deepwork.settings.save).mockRejectedValueOnce(new Error("disk full"));
    const onDone = vi.fn();
    render(<Onboarding settings={settings} onDone={onDone} />);
    fireEvent.click(screen.getByText("onboarding.continue"));
    expect(await screen.findByText(/disk full/)).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("recovers from verification failures instead of remaining disabled", async () => {
    vi.mocked(window.deepwork.models.verify).mockRejectedValueOnce(new Error("network unavailable"));
    render(<Onboarding settings={settings} onDone={vi.fn()} />);
    fireEvent.click(screen.getByText("common.test"));
    expect(await screen.findByText(/network unavailable/)).toBeTruthy();
    expect((screen.getByText("common.test") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText("onboarding.continue") as HTMLButtonElement).disabled).toBe(false);
  });
});
