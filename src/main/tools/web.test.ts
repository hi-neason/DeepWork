import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

  // C-A2 缺口：webGuard 对域名不解析 DNS，指向私网的域名（如 *.nip.io 解析到
  // 127.0.0.1、或 169.254.169.254 的云元数据域名）会被放行，webFetchTool 也不会
  // 拦截。正确行为：应解析域名并校验解析后的 IP。重构修掉后此 todo 转绿。
  it.todo("webFetchTool 应拦截指向私网的域名（C-A2：webGuard 不解析 DNS）");
});
