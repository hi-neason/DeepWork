import { describe, it, expect, vi, afterEach } from "vitest";
import dns from "node:dns/promises";
import {
  isPublicHost,
  assertPublicUrl,
  assertPublicUrlResolved,
  assertConfiguredEndpoint,
  normalizeIPv4,
  htmlToText,
} from "./webGuard";

/**
 * webGuard 单元测试。
 *
 * 设计原则：用例编码"应当正确的行为"。其中被当前实现遗漏的 SSRF 缺口，
 * 写成 `it.todo(...)`（运行时不红，呈 pending），作为重构修掉 C-A2 后的
 * 回归项——届时把这些 todo 改成 `it` 即可转绿。
 */

describe("isPublicHost - IPv4 私网/保留地址拦截", () => {
  it("拦截 loopback 127.0.0.0/8", () => {
    expect(isPublicHost("127.0.0.1")).toBe(false);
    expect(isPublicHost("127.255.255.254")).toBe(false);
  });

  it("拦截私有网段 10.0.0.0/8", () => {
    expect(isPublicHost("10.0.0.1")).toBe(false);
    expect(isPublicHost("10.255.255.255")).toBe(false);
  });

  it("拦截 0.0.0.0/8", () => {
    expect(isPublicHost("0.0.0.0")).toBe(false);
    expect(isPublicHost("0.255.255.255")).toBe(false);
  });

  it("拦截链路本地 / 云元数据 169.254.0.0/16", () => {
    expect(isPublicHost("169.254.169.254")).toBe(false);
    expect(isPublicHost("169.254.0.1")).toBe(false);
  });

  it("拦截私有网段 172.16.0.0/12", () => {
    expect(isPublicHost("172.16.0.1")).toBe(false);
    expect(isPublicHost("172.31.255.255")).toBe(false);
    // 172.32 不在范围内，应放行
    expect(isPublicHost("172.32.0.1")).toBe(true);
  });

  it("拦截私有网段 192.168.0.0/16", () => {
    expect(isPublicHost("192.168.1.1")).toBe(false);
    expect(isPublicHost("192.168.255.254")).toBe(false);
  });

  it("拦截组播 / 保留 224.0.0.0/3", () => {
    expect(isPublicHost("224.0.0.1")).toBe(false);
    expect(isPublicHost("255.255.255.255")).toBe(false);
  });

  it("拦截 CGNAT 100.64.0.0/10", () => {
    expect(isPublicHost("100.64.0.0")).toBe(false);
    expect(isPublicHost("100.127.255.255")).toBe(false);
    expect(isPublicHost("100.128.0.0")).toBe(true);
  });

  it("放行公网 IPv4", () => {
    expect(isPublicHost("8.8.8.8")).toBe(true);
    expect(isPublicHost("1.1.1.1")).toBe(true);
    expect(isPublicHost("203.0.113.5")).toBe(true);
  });
});

describe("isPublicHost - IPv6 拦截", () => {
  it("拦截 loopback ::1 与未指定 ::", () => {
    expect(isPublicHost("::1")).toBe(false);
    expect(isPublicHost("::")).toBe(false);
  });

  it("拦截链路本地 fe80::/10", () => {
    expect(isPublicHost("fe80::1")).toBe(false);
    expect(isPublicHost("febf:ffff::1")).toBe(false);
  });

  it("拦截唯一本地 fc00::/7", () => {
    expect(isPublicHost("fc00::1")).toBe(false);
    expect(isPublicHost("fd12:3456::1")).toBe(false);
  });

  it("放行公网 IPv6", () => {
    expect(isPublicHost("2001:db8::1")).toBe(true);
    expect(isPublicHost("2606:4700:4700::1111")).toBe(true);
  });
});

describe("isPublicHost - 主机名 / 特殊 TLD", () => {
  it("拦截 localhost 及其子域", () => {
    expect(isPublicHost("localhost")).toBe(false);
    expect(isPublicHost("api.localhost")).toBe(false);
  });

  it("拦截 .internal / .local TLD", () => {
    expect(isPublicHost("db.internal")).toBe(false);
    expect(isPublicHost("printer.local")).toBe(false);
  });

  it("放行普通公网域名", () => {
    expect(isPublicHost("example.com")).toBe(true);
    expect(isPublicHost("api.deepwork.app")).toBe(true);
  });
});

describe("assertPublicUrl", () => {
  it("放行合法公网 http/https", () => {
    expect(assertPublicUrl("https://example.com/path").hostname).toBe("example.com");
    expect(assertPublicUrl("http://1.1.1.1/").hostname).toBe("1.1.1.1");
  });

  it("拒绝非 http/https 协议", () => {
    expect(() => assertPublicUrl("ftp://example.com")).toThrow();
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow();
  });

  it("拒绝非法 URL", () => {
    expect(() => assertPublicUrl("not a url")).toThrow();
  });

  it("拒绝私网主机", () => {
    expect(() => assertPublicUrl("http://169.254.169.254/latest/meta-data/")).toThrow();
    expect(() => assertPublicUrl("http://localhost:8080/")).toThrow();
  });
});

describe("htmlToText", () => {
  it("剥离 script / style / noscript", () => {
    const html = "<p>hi</p><script>alert(1)</script><style>.a{color:red}</style>";
    expect(htmlToText(html)).toBe("hi");
  });

  it("将块级标签与 <br> 转为换行", () => {
    const html = "a<br>b<div>c</div><p>d</p>";
    const out = htmlToText(html);
    expect(out).toContain("a");
    expect(out).toContain("b");
    expect(out).toContain("c");
    expect(out).toContain("d");
  });

  it("解码常见 HTML 实体", () => {
    expect(htmlToText("a&amp;b&lt;c&gt;d&quot;e&quot;")).toBe('a&b<c>d"e"');
    expect(htmlToText("&#65;&#66;")).toBe("AB");
  });
});

// ---- C-T1 / C-T2 修复后的 SSRF 回归 ----
describe("isPublicHost - IP 编码变体（C-T1）", () => {
  it("拦截 IPv4-mapped / IPv4-compatible IPv6", () => {
    expect(isPublicHost("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicHost("[::ffff:127.0.0.1]")).toBe(false);
    expect(isPublicHost("::ffff:169.254.169.254")).toBe(false);
    // 十六进制写法的同一地址
    expect(isPublicHost("::ffff:7f00:1")).toBe(false);
    // mapped 的公网地址仍放行
    expect(isPublicHost("::ffff:8.8.8.8")).toBe(true);
  });

  it("拦截十进制 / 十六进制 / 八进制编码的 IPv4", () => {
    expect(isPublicHost("2130706433")).toBe(false); // 127.0.0.1
    expect(isPublicHost("0x7f000001")).toBe(false);
    expect(isPublicHost("0177.0.0.1")).toBe(false);
    expect(isPublicHost("127.1")).toBe(false); // 短写法
    expect(isPublicHost("2852039166")).toBe(false); // 169.254.169.254
    expect(assertPublicUrl.bind(null, "http://2130706433/")).toThrow();
  });

  it("normalizeIPv4 归一化各种写法", () => {
    expect(normalizeIPv4("2130706433")).toBe("127.0.0.1");
    expect(normalizeIPv4("0x7f000001")).toBe("127.0.0.1");
    expect(normalizeIPv4("127.1")).toBe("127.0.0.1");
    expect(normalizeIPv4("8.8.8.8")).toBe("8.8.8.8");
    expect(normalizeIPv4("example.com")).toBeNull();
    expect(normalizeIPv4("999.1.1.1")).toBeNull();
  });

  it("拦截其它内网 TLD", () => {
    expect(isPublicHost("box.home.arpa")).toBe(false);
    expect(isPublicHost("nas.localdomain")).toBe(false);
  });
});

describe("assertPublicUrlResolved - DNS 解析后重判（C-T1）", () => {
  afterEach(() => vi.restoreAllMocks());

  it("域名解析到私网地址时拒绝（如 nip.io 类回环域名）", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "169.254.169.254", family: 4 },
    ] as never);
    await expect(
      assertPublicUrlResolved("http://169.254.169.254.nip.io/latest/meta-data/"),
    ).rejects.toThrow(/non-public/);
  });

  it("多条 A 记录中只要有一条私网就整体拒绝", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ] as never);
    await expect(assertPublicUrlResolved("https://evil.example/")).rejects.toThrow(
      /non-public/,
    );
  });

  it("解析到 IPv4-mapped IPv6 私网也拒绝", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "::ffff:127.0.0.1", family: 6 },
    ] as never);
    await expect(assertPublicUrlResolved("https://sneaky.example/")).rejects.toThrow(
      /non-public/,
    );
  });

  it("全部解析为公网地址时放行", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
    const u = await assertPublicUrlResolved("https://example.com/p");
    expect(u.hostname).toBe("example.com");
  });

  it("解析失败 / 无地址时拒绝（fail-closed）", async () => {
    vi.spyOn(dns, "lookup").mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertPublicUrlResolved("https://nope.example/")).rejects.toThrow(
      /cannot resolve/,
    );
    vi.spyOn(dns, "lookup").mockResolvedValue([] as never);
    await expect(assertPublicUrlResolved("https://empty.example/")).rejects.toThrow(
      /no addresses/,
    );
  });

  it("IP 字面量直连不触发 DNS 查询", async () => {
    const spy = vi.spyOn(dns, "lookup");
    const u = await assertPublicUrlResolved("http://1.1.1.1/");
    expect(u.hostname).toBe("1.1.1.1");
    expect(spy).not.toHaveBeenCalled();
  });

  it("拒绝 URL 内嵌凭据（绕过审计的常见手法）", () => {
    expect(() => assertPublicUrl("http://user:pw@example.com/")).toThrow();
  });
});

describe("assertConfiguredEndpoint — 用户配置的模型/embedding base URL 校验", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("放行 localhost / 127.0.0.1（本地 Ollama 合法用例）", async () => {
    const u = await assertConfiguredEndpoint("http://localhost:11434");
    expect(u.hostname).toBe("localhost");
    const u2 = await assertConfiguredEndpoint("http://127.0.0.1:11434");
    expect(u2.hostname).toBe("127.0.0.1");
  });

  it("放行私网地址（自托管网关合法用例）", async () => {
    const u = await assertConfiguredEndpoint("http://192.168.1.10:8080");
    expect(u.hostname).toBe("192.168.1.10");
  });

  it("放行公网 HTTPS 地址", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
    const u = await assertConfiguredEndpoint("https://api.example.com/v1");
    expect(u.hostname).toBe("api.example.com");
  });

  it("拦截 169.254.169.254 云元数据地址（SSRF 目标）", async () => {
    await expect(
      assertConfiguredEndpoint("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/link-local|metadata/i);
  });

  it("拦截 169.254 段内其他地址", async () => {
    await expect(
      assertConfiguredEndpoint("http://169.254.0.1/"),
    ).rejects.toThrow(/link-local|metadata/i);
  });

  it("拦截解析到 link-local 的主机名（DNS rebinding 型 SSRF）", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "169.254.169.254", family: 4 },
    ] as never);
    await expect(
      assertConfiguredEndpoint("http://evil.example/"),
    ).rejects.toThrow(/link-local/i);
  });

  it("拒绝非 http(s) 协议", async () => {
    await expect(assertConfiguredEndpoint("file:///etc/passwd")).rejects.toThrow(
      /http/,
    );
    await expect(
      assertConfiguredEndpoint("javascript:alert(1)"),
    ).rejects.toThrow(/http/);
  });

  it("拒绝 URL 内嵌凭据", async () => {
    await expect(
      assertConfiguredEndpoint("http://user:pass@localhost:11434/"),
    ).rejects.toThrow(/Credential/i);
  });
});
