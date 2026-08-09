import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import dns from "node:dns/promises";
import { webFetchTool, webSearchTool } from "./web";

describe("tools/web", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("webFetchTool rejects private IPs (SSRF protection enforced at the web layer, locks C-A2)", async () => {
    await expect(
      webFetchTool.tool.invoke({ url: "http://127.0.0.1/" }),
    ).rejects.toThrow();
    // It should be blocked by assertPublicUrl before any real network request is made
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("webFetchTool rejects loopback hostnames", async () => {
    await expect(
      webFetchTool.tool.invoke({ url: "http://localhost/" }),
    ).rejects.toThrow();
  });

  it("webFetchTool fetches and returns content for a public URL", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "text/html" },
      text: async () => "<html><body><p>hello world</p></body></html>",
    } as any);
    const res = await webFetchTool.tool.invoke({ url: "https://example.com/" });
    expect(fetchMock).toHaveBeenCalled();
    expect(res).toContain("Contents of https://example.com");
  });

  it("webSearchTool parses DuckDuckGo HTML results", async () => {
    const html =
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Example</a>' +
      '<a class="result__snippet">A snippet about example</a>';
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "text/html" },
      text: async () => html,
    } as any);
    const res = await webSearchTool.tool.invoke({ query: "example" });
    expect(res).toContain("Example");
    expect(res).toContain("https://example.com");
  });

  // C-A2: before making a request, webGuard resolves the domain and validates
  // the resolved IP. Therefore public domains that point to private networks
  // (e.g. *.nip.io resolving to 127.0.0.1, or cloud metadata 169.254.169.254)
  // are blocked, and fetch is not called before the block.
  it("webFetchTool blocks domains pointing to private networks (C-A2: webGuard resolves DNS)", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "127.0.0.1", family: 4 },
    ] as never);

    await expect(
      webFetchTool.tool.invoke({ url: "http://private.nip.io/" }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("webFetchTool blocks domains resolving to the cloud metadata address (169.254.169.254)", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "169.254.169.254", family: 4 },
    ] as never);

    await expect(
      webFetchTool.tool.invoke({ url: "http://169.254.169.254.nip.io/latest/meta-data/" }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
