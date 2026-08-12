// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileToAttachment } from "./attachments";

afterEach(() => vi.restoreAllMocks());

describe("fileToAttachment", () => {
  it.each([
    ["photo.png", "image/png", "image"],
    ["report.pdf", "application/pdf", "pdf"],
    ["fallback.PDF", "", "pdf"],
    ["notes.md", "", "text"],
    ["data.json", "application/json", "text"],
    ["archive.bin", "application/octet-stream", "text"],
  ] as const)("classifies %s as %s content", async (name, mime, kind) => {
    const file = new File(["content"], name, { type: mime });
    Object.defineProperty(file, "text", { value: vi.fn(async () => "content") });
    const attachment = await fileToAttachment(file);
    expect(attachment).toMatchObject({ name, mimeType: mime || "application/octet-stream", size: 7, kind });
    expect(attachment.dataUrl).toMatch(/^data:/);
    expect(attachment.id).toMatch(/^\d+-[a-z0-9]+$/);
    expect(attachment.text).toBe(kind === "text" && (mime.startsWith("text/") || /\.(md|json)$/i.test(name)) ? "content" : undefined);
  });

  it("propagates FileReader failures", async () => {
    const original = globalThis.FileReader;
    class FailingReader {
      result: string | null = null;
      error = new Error("read failed");
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(): void { this.onerror?.(); }
    }
    vi.stubGlobal("FileReader", FailingReader);
    await expect(fileToAttachment(new File(["x"], "x.txt", { type: "text/plain" })))
      .rejects.toThrow("read failed");
    vi.stubGlobal("FileReader", original);
  });
});
