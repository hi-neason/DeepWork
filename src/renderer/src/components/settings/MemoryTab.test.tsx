// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryTab } from "./MemoryTab";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
describe("MemoryTab", () => {
  beforeEach(() => {
    Object.defineProperty(window, "deepwork", { configurable: true, value: {
      memories: {
        list: vi.fn(async () => [{ id: "m1", content: "Likes green", status: "active" }]),
        invalidate: vi.fn(async () => undefined), restore: vi.fn(async () => undefined),
      },
      userMemory: {
        raw: vi.fn(async () => "# Original"), path: vi.fn(async () => "/memory.md"),
        saveRaw: vi.fn(async () => undefined),
      },
      timeline: { list: vi.fn(async () => []), read: vi.fn(), path: vi.fn() },
      projectMemory: { list: vi.fn(async () => []), read: vi.fn(), path: vi.fn() },
    } });
  });
  afterEach(cleanup);

  it("invalidates and reloads structured memories", async () => {
    render(<MemoryTab />);
    fireEvent.click(screen.getByText("settings.memory.tabs.structured"));
    expect(await screen.findByText("Likes green")).toBeTruthy();
    fireEvent.click(screen.getByText("settings.memory.structured.invalidate"));
    await waitFor(() => expect(window.deepwork.memories.invalidate).toHaveBeenCalledWith("m1"));
    expect(window.deepwork.memories.list).toHaveBeenCalledTimes(2);
  });

  it("edits, resets, and saves raw user memory", async () => {
    render(<MemoryTab />);
    const editor = await screen.findByDisplayValue("# Original");
    fireEvent.change(editor, { target: { value: "# Changed" } });
    fireEvent.click(screen.getByText("common.cancel"));
    expect((editor as HTMLTextAreaElement).value).toBe("# Original");
    fireEvent.change(editor, { target: { value: "# Saved" } });
    fireEvent.click(screen.getByText("common.save"));
    await waitFor(() => expect(window.deepwork.userMemory.saveRaw).toHaveBeenCalledWith("# Saved"));
    expect(screen.getByText("/memory.md")).toBeTruthy();
  });

  it("renders empty timeline and project states", async () => {
    render(<MemoryTab />);
    fireEvent.click(screen.getByText("settings.memory.tabs.timeline"));
    expect(await screen.findByText("settings.memory.timeline.empty")).toBeTruthy();
    fireEvent.click(screen.getByText("settings.memory.tabs.project"));
    expect(await screen.findByText("settings.memory.project.empty")).toBeTruthy();
  });
});
