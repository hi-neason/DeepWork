// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalErrorBoundary } from "./TerminalErrorBoundary";

vi.mock("../i18n", () => ({ default: { t: (key: string, options?: { message?: string }) => options?.message ? `${key}:${options.message}` : key } }));

function CrashingChild(): React.ReactElement {
  throw new Error("xterm crashed");
}

afterEach(cleanup);

describe("TerminalErrorBoundary", () => {
  it("isolates child crashes and lets the user close the terminal", () => {
    const onClose = vi.fn();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<TerminalErrorBoundary onClose={onClose}><CrashingChild /></TerminalErrorBoundary>);
    expect(screen.getByText("terminal.componentError:xterm crashed")).toBeTruthy();
    fireEvent.click(screen.getByTitle("terminal.close"));
    expect(onClose).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("renders healthy children unchanged", () => {
    render(<TerminalErrorBoundary onClose={vi.fn()}><div>healthy</div></TerminalErrorBoundary>);
    expect(screen.getByText("healthy")).toBeTruthy();
  });
});
