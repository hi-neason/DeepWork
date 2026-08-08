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

  it("webFetchTool 拒绝私有 IP（SSRF 防护在 web 层生效，锁 C-A2）", async () => {
    await expect(
      webFetchTool.tool.invoke({ url: "http://127.0.0.1/" }),
    ).rejects.toThrow();
    // 在真正发起网络请求前就应被 assertPublicUrl 拦截
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("webFetchTool 拒绝 loopback 主机名", async () => {
    await expect(
      webFetchTool.tool.invoke({ url: "http://localhost/" }),
    ).rejects.toThrow();
  });

  it("webFetchTool 对公网 URL 正常抓取并返回内容", async () => {
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

  it("webSearchTool 解析 DuckDuckGo HTML 结果", async () => {
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

  // C-A2：webGuard 在发起请求前解析域名并校验解析后的 IP，因此指向私网的
  // 公网域名（如 *.nip.io 解析到 127.0.0.1、云元数据 169.254.169.254）会被拦截，
  // 且 fetch 在拦截前不会被调用。
  it("webFetchTool 应拦截指向私网的域名（C-A2：webGuard 解析 DNS）", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "127.0.0.1", family: 4 },
    ] as never);

    await expect(
      webFetchTool.tool.invoke({ url: "http://private.nip.io/" }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("webFetchTool 拦截解析到云元数据地址（169.254.169.254）的域名", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "169.254.169.254", family: 4 },
    ] as never);

    await expect(
      webFetchTool.tool.invoke({ url: "http://169.254.169.254.nip.io/latest/meta-data/" }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
