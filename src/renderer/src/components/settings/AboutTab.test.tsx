// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AboutTab } from "./AboutTab";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe("AboutTab", () => {
  beforeEach(() => {
    Object.defineProperty(window, "deepwork", { configurable: true, value: {
      app: { dataPath: vi.fn(async () => "/data/deepwork"), version: vi.fn(async () => "1.2.3"), revealData: vi.fn() },
      updates: { check: vi.fn(), install: vi.fn() },
    } });
  });
  afterEach(cleanup);

  it("loads application metadata, reveals data, and checks updates", async () => {
    render(<AboutTab updateStatus={{ state: "idle" }} />);
    await waitFor(() => expect(screen.getByText(/DeepWork v1.2.3/)).toBeTruthy());
    expect(screen.getByText("/data/deepwork")).toBeTruthy();
    fireEvent.click(screen.getByText("settings.about.showInFinder"));
    fireEvent.click(screen.getByText("settings.about.checkUpdate"));
    expect(window.deepwork.app.revealData).toHaveBeenCalled();
    expect(window.deepwork.updates.check).toHaveBeenCalled();
  });

  it.each([
    [{ state: "checking" as const }, "settings.about.updateChecking"],
    [{ state: "available" as const, version: "2.0" }, "settings.about.updateAvailable"],
    [{ state: "downloading" as const, percent: 42 }, "settings.about.updateDownloading"],
    [{ state: "error" as const, message: "offline" }, "settings.about.updateError"],
    [{ state: "not-available" as const }, "settings.about.updateNotAvailable"],
  ])("renders update state %#", (status, label) => {
    render(<AboutTab updateStatus={status} />);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it("installs a downloaded update", () => {
    render(<AboutTab updateStatus={{ state: "downloaded", version: "2.0" }} />);
    fireEvent.click(screen.getByText("settings.about.restartAndUpdate"));
    expect(window.deepwork.updates.install).toHaveBeenCalled();
  });
});
