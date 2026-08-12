// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Connectors } from "./Connectors";
import type { Settings } from "../../../shared/types";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const settings = { mcpServers: [{
  id: "m1", label: "local", transport: "stdio", command: "node", args: ["server.js"], enabled: true,
}] } as Settings;

describe("Connectors", () => {
  beforeEach(() => {
    Object.defineProperty(window, "deepwork", { configurable: true, value: {
      mcp: { status: vi.fn(async () => [{ id: "m1", ok: false, error: "offline" }]) },
    } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("shows status, toggles, edits valid JSON, and rejects malformed JSON", async () => {
    const onChange = vi.fn();
    render(<Connectors settings={settings} onChange={onChange} />);
    expect(await screen.findByText(/offline/)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith({ mcpServers: [expect.objectContaining({ enabled: false })] });
    fireEvent.click(screen.getByTitle("common.edit"));
    const editor = screen.getByDisplayValue(/server.js/);
    fireEvent.change(editor, { target: { value: "not-json" } });
    expect(await screen.findByText("connectors.jsonParseError")).toBeTruthy();
    fireEvent.change(editor, { target: { value: '{"remote":{"url":"https://example.com/sse","enabled":true}}' } });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({
      mcpServers: [expect.objectContaining({ label: "remote", transport: "sse", url: "https://example.com/sse" })],
    }));
  });

  it("imports valid batches and reports malformed or duplicate imports", () => {
    const onChange = vi.fn();
    render(<Connectors settings={settings} onChange={onChange} />);
    fireEvent.click(screen.getByText("connectors.importTitle"));
    const input = screen.getByPlaceholderText("connectors.importPlaceholder");
    fireEvent.change(input, { target: { value: "{" } });
    fireEvent.click(screen.getByText("connectors.importBtn"));
    expect(screen.getByText("connectors.importError")).toBeTruthy();
    fireEvent.change(input, { target: { value: '{"remote":{"url":"https://example.com/sse"}}' } });
    fireEvent.click(screen.getByText("connectors.importBtn"));
    expect(onChange).toHaveBeenCalledWith({ mcpServers: expect.arrayContaining([expect.objectContaining({ label: "remote" })]) });

    cleanup();
    render(<Connectors settings={settings} onChange={onChange} />);
    fireEvent.click(screen.getByText("connectors.importTitle"));
    fireEvent.change(screen.getByPlaceholderText("connectors.importPlaceholder"), { target: { value: '{"local":{"command":"node"}}' } });
    fireEvent.click(screen.getByText("connectors.importBtn"));
    expect(screen.getByText("connectors.importDuplicate")).toBeTruthy();
  });

  it("adds and deletes servers and tolerates status lookup failure", async () => {
    vi.mocked(window.deepwork.mcp.status).mockRejectedValueOnce(new Error("unavailable"));
    const onChange = vi.fn();
    render(<Connectors settings={settings} onChange={onChange} />);
    fireEvent.click(screen.getByText("connectors.addMcp"));
    expect(onChange).toHaveBeenCalledWith({ mcpServers: expect.arrayContaining([expect.objectContaining({ label: "my-server" })]) });
    fireEvent.click(screen.getByTitle("common.delete"));
    expect(onChange).toHaveBeenCalledWith({ mcpServers: [] });
    await waitFor(() => expect(window.deepwork.mcp.status).toHaveBeenCalled());
  });
});
