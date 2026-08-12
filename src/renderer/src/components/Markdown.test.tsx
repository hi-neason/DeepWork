// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

afterEach(cleanup);

describe("Markdown", () => {
  it("renders GFM tables, task lists, code, and safe external link attributes", () => {
    render(<Markdown content={'# Title\n\n- [x] done\n\n|A|B|\n|-|-|\n|1|2|\n\n`code`\n\n[site](https://example.com)'} />);
    expect(screen.getByRole("heading", { name: "Title" })).toBeTruthy();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("code")).toBeTruthy();
    const link = screen.getByRole("link", { name: "site" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });

  it("does not interpret raw HTML as executable DOM", () => {
    render(<Markdown content={'<script>alert(1)</script><img src=x onerror=alert(1)>'} />);
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/script/)).toBeTruthy();
  });

  it("handles empty and malformed markdown without crashing", () => {
    const { rerender } = render(<Markdown content="" />);
    expect(document.querySelector(".markdown")).toBeTruthy();
    rerender(<Markdown content={'```ts\nconst x = 1'} />);
    expect(screen.getByText(/const x = 1/)).toBeTruthy();
  });
});
