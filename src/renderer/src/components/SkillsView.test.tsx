// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsView } from "./SkillsView";
import type { Settings, Skill } from "../../../shared/types";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const skill: Skill = { name: "test-skill", description: "Test", body: "Body", enabled: true, updatedAt: 1, files: [] };

describe("SkillsView", () => {
  beforeEach(() => {
    Object.defineProperty(window, "deepwork", { configurable: true, value: {
      skills: {
        list: vi.fn(async () => [skill]), create: vi.fn(async () => skill),
        update: vi.fn(async (_name, patch) => ({ ...skill, ...patch })), delete: vi.fn(async () => undefined),
        rename: vi.fn(async (_old, name) => ({ ...skill, name })), import: vi.fn(async () => skill),
        export: vi.fn(async () => "/tmp/export/test-skill"), rebuild: vi.fn(async () => undefined),
      },
      settings: { pickDirectory: vi.fn(async () => "/tmp/folder") },
    } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(window, "alert").mockImplementation(() => undefined);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("creates a skill and surfaces create failures", async () => {
    render(<SkillsView settings={{} as Settings} />);
    fireEvent.click(await screen.findByText(/skills.new/));
    fireEvent.change(screen.getByPlaceholderText("my-awesome-skill"), { target: { value: "new-skill" } });
    fireEvent.click(screen.getByText("skills.create"));
    await waitFor(() => expect(window.deepwork.skills.create).toHaveBeenCalledWith({ name: "new-skill", description: "", body: "" }));
    cleanup();
    vi.mocked(window.deepwork.skills.create).mockRejectedValueOnce(new Error("duplicate"));
    render(<SkillsView settings={{} as Settings} />);
    fireEvent.click(await screen.findByText(/skills.new/));
    fireEvent.click(screen.getByText("skills.create"));
    expect(await screen.findByText("duplicate")).toBeTruthy();
  });

  it("toggles, imports, exports, and deletes skills", async () => {
    render(<SkillsView settings={{} as Settings} />);
    await screen.findByText("test-skill");
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(window.deepwork.skills.update).toHaveBeenCalledWith("test-skill", { enabled: false }));
    fireEvent.click(screen.getByText("skills.import"));
    await waitFor(() => expect(window.deepwork.skills.import).toHaveBeenCalledWith("/tmp/folder"));
    fireEvent.click(screen.getByText("skills.back"));
    fireEvent.click(screen.getByTitle("skills.export"));
    await waitFor(() => expect(window.deepwork.skills.export).toHaveBeenCalledWith("test-skill", "/tmp/folder"));
    fireEvent.click(screen.getByTitle("common.delete"));
    await waitFor(() => expect(window.deepwork.skills.delete).toHaveBeenCalledWith("test-skill"));
  });

  it("ignores picker cancellation and reports import failures", async () => {
    vi.mocked(window.deepwork.settings.pickDirectory).mockResolvedValueOnce(null);
    render(<SkillsView settings={{} as Settings} />);
    fireEvent.click(await screen.findByText("skills.import"));
    await waitFor(() => expect(window.deepwork.settings.pickDirectory).toHaveBeenCalled());
    expect(window.deepwork.skills.import).not.toHaveBeenCalled();
    vi.mocked(window.deepwork.settings.pickDirectory).mockResolvedValueOnce("/tmp/bad");
    vi.mocked(window.deepwork.skills.import).mockRejectedValueOnce(new Error("invalid skill"));
    fireEvent.click(screen.getByText("skills.import"));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith("invalid skill"));
  });
});
