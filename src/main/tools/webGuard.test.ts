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
 * webGuard unit tests.
 *
 * Design principle: the cases encode "the correct behavior". SSRF gaps that are
 * missed by the current implementation are written as `it.todo(...)` (not red at
 * runtime, shown as pending) to serve as regression items once C-A2 is fixed in
 * a refactor — at that point turning these todos into `it` will make them green.
 */

describe("isPublicHost - IPv4 private/reserved address blocking", () => {
  it("blocks loopback 127.0.0.0/8", () => {
    expect(isPublicHost("127.0.0.1")).toBe(false);
    expect(isPublicHost("127.255.255.254")).toBe(false);
  });

  it("blocks private range 10.0.0.0/8", () => {
    expect(isPublicHost("10.0.0.1")).toBe(false);
    expect(isPublicHost("10.255.255.255")).toBe(false);
  });

  it("blocks 0.0.0.0/8", () => {
    expect(isPublicHost("0.0.0.0")).toBe(false);
    expect(isPublicHost("0.255.255.255")).toBe(false);
  });

  it("blocks link-local / cloud metadata 169.254.0.0/16", () => {
    expect(isPublicHost("169.254.169.254")).toBe(false);
    expect(isPublicHost("169.254.0.1")).toBe(false);
  });

  it("blocks private range 172.16.0.0/12", () => {
    expect(isPublicHost("172.16.0.1")).toBe(false);
    expect(isPublicHost("172.31.255.255")).toBe(false);
    // 172.32 is not in range and should be allowed
    expect(isPublicHost("172.32.0.1")).toBe(true);
  });

  it("blocks private range 192.168.0.0/16", () => {
    expect(isPublicHost("192.168.1.1")).toBe(false);
    expect(isPublicHost("192.168.255.254")).toBe(false);
  });

  it("blocks multicast / reserved 224.0.0.0/3", () => {
    expect(isPublicHost("224.0.0.1")).toBe(false);
    expect(isPublicHost("255.255.255.255")).toBe(false);
  });

  it("blocks CGNAT 100.64.0.0/10", () => {
    expect(isPublicHost("100.64.0.0")).toBe(false);
    expect(isPublicHost("100.127.255.255")).toBe(false);
    expect(isPublicHost("100.128.0.0")).toBe(true);
  });

  it("allows public IPv4", () => {
    expect(isPublicHost("8.8.8.8")).toBe(true);
    expect(isPublicHost("1.1.1.1")).toBe(true);
    expect(isPublicHost("203.0.113.5")).toBe(true);
  });
});

describe("isPublicHost - IPv6 blocking", () => {
  it("blocks loopback ::1 and unspecified ::", () => {
    expect(isPublicHost("::1")).toBe(false);
    expect(isPublicHost("::")).toBe(false);
  });

  it("blocks link-local fe80::/10", () => {
    expect(isPublicHost("fe80::1")).toBe(false);
    expect(isPublicHost("febf:ffff::1")).toBe(false);
  });

  it("blocks unique-local fc00::/7", () => {
    expect(isPublicHost("fc00::1")).toBe(false);
    expect(isPublicHost("fd12:3456::1")).toBe(false);
  });

  it("allows public IPv6", () => {
    expect(isPublicHost("2001:db8::1")).toBe(true);
    expect(isPublicHost("2606:4700:4700::1111")).toBe(true);
  });
});

describe("isPublicHost - hostnames / special TLDs", () => {
  it("blocks localhost and its subdomains", () => {
    expect(isPublicHost("localhost")).toBe(false);
    expect(isPublicHost("api.localhost")).toBe(false);
  });

  it("blocks .internal / .local TLDs", () => {
    expect(isPublicHost("db.internal")).toBe(false);
    expect(isPublicHost("printer.local")).toBe(false);
  });

  it("allows ordinary public domains", () => {
    expect(isPublicHost("example.com")).toBe(true);
    expect(isPublicHost("api.deepwork.app")).toBe(true);
  });
});

describe("assertPublicUrl", () => {
  it("allows valid public http/https", () => {
    expect(assertPublicUrl("https://example.com/path").hostname).toBe("example.com");
    expect(assertPublicUrl("http://1.1.1.1/").hostname).toBe("1.1.1.1");
  });

  it("rejects non-http/https protocols", () => {
    expect(() => assertPublicUrl("ftp://example.com")).toThrow();
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow();
  });

  it("rejects invalid URLs", () => {
    expect(() => assertPublicUrl("not a url")).toThrow();
  });

  it("rejects private hosts", () => {
    expect(() => assertPublicUrl("http://169.254.169.254/latest/meta-data/")).toThrow();
    expect(() => assertPublicUrl("http://localhost:8080/")).toThrow();
  });
});

describe("htmlToText", () => {
  it("strips script / style / noscript", () => {
    const html = "<p>hi</p><script>alert(1)</script><style>.a{color:red}</style>";
    expect(htmlToText(html)).toBe("hi");
  });

  it("converts block-level tags and <br> to newlines", () => {
    const html = "a<br>b<div>c</div><p>d</p>";
    const out = htmlToText(html);
    expect(out).toContain("a");
    expect(out).toContain("b");
    expect(out).toContain("c");
    expect(out).toContain("d");
  });

  it("decodes common HTML entities", () => {
    expect(htmlToText("a&amp;b&lt;c&gt;d&quot;e&quot;")).toBe('a&b<c>d"e"');
    expect(htmlToText("&#65;&#66;")).toBe("AB");
  });
});

// ---- Post-fix SSRF regression for C-T1 / C-T2 ----
describe("isPublicHost - IP encoding variants (C-T1)", () => {
  it("blocks IPv4-mapped / IPv4-compatible IPv6", () => {
    expect(isPublicHost("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicHost("[::ffff:127.0.0.1]")).toBe(false);
    expect(isPublicHost("::ffff:169.254.169.254")).toBe(false);
    // The same address in hexadecimal notation
    expect(isPublicHost("::ffff:7f00:1")).toBe(false);
    // A mapped public address is still allowed
    expect(isPublicHost("::ffff:8.8.8.8")).toBe(true);
  });

  it("blocks IPv4 encoded in decimal / hexadecimal / octal", () => {
    expect(isPublicHost("2130706433")).toBe(false); // 127.0.0.1
    expect(isPublicHost("0x7f000001")).toBe(false);
    expect(isPublicHost("0177.0.0.1")).toBe(false);
    expect(isPublicHost("127.1")).toBe(false); // short notation
    expect(isPublicHost("2852039166")).toBe(false); // 169.254.169.254
    expect(assertPublicUrl.bind(null, "http://2130706433/")).toThrow();
  });

  it("normalizeIPv4 normalizes various notations", () => {
    expect(normalizeIPv4("2130706433")).toBe("127.0.0.1");
    expect(normalizeIPv4("0x7f000001")).toBe("127.0.0.1");
    expect(normalizeIPv4("127.1")).toBe("127.0.0.1");
    expect(normalizeIPv4("8.8.8.8")).toBe("8.8.8.8");
    expect(normalizeIPv4("example.com")).toBeNull();
    expect(normalizeIPv4("999.1.1.1")).toBeNull();
  });

  it("blocks other intranet TLDs", () => {
    expect(isPublicHost("box.home.arpa")).toBe(false);
    expect(isPublicHost("nas.localdomain")).toBe(false);
  });
});

describe("assertPublicUrlResolved - re-check after DNS resolution (C-T1)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects when the domain resolves to a private address (e.g. nip.io-style loopback domains)", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "169.254.169.254", family: 4 },
    ] as never);
    await expect(
      assertPublicUrlResolved("http://169.254.169.254.nip.io/latest/meta-data/"),
    ).rejects.toThrow(/non-public/);
  });

  it("rejects the whole set when any one of multiple A records is private", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ] as never);
    await expect(assertPublicUrlResolved("https://evil.example/")).rejects.toThrow(
      /non-public/,
    );
  });

  it("also rejects when resolution yields an IPv4-mapped IPv6 private address", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "::ffff:127.0.0.1", family: 6 },
    ] as never);
    await expect(assertPublicUrlResolved("https://sneaky.example/")).rejects.toThrow(
      /non-public/,
    );
  });

  it("allows when all resolutions are public addresses", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
    const u = await assertPublicUrlResolved("https://example.com/p");
    expect(u.hostname).toBe("example.com");
  });

  it("rejects on resolution failure / no addresses (fail-closed)", async () => {
    vi.spyOn(dns, "lookup").mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertPublicUrlResolved("https://nope.example/")).rejects.toThrow(
      /cannot resolve/,
    );
    vi.spyOn(dns, "lookup").mockResolvedValue([] as never);
    await expect(assertPublicUrlResolved("https://empty.example/")).rejects.toThrow(
      /no addresses/,
    );
  });

  it("a direct IP literal does not trigger a DNS lookup", async () => {
    const spy = vi.spyOn(dns, "lookup");
    const u = await assertPublicUrlResolved("http://1.1.1.1/");
    expect(u.hostname).toBe("1.1.1.1");
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects credentials embedded in the URL (a common audit-bypass technique)", () => {
    expect(() => assertPublicUrl("http://user:pw@example.com/")).toThrow();
  });
});

describe("assertConfiguredEndpoint - validation of user-configured model/embedding base URLs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows localhost / 127.0.0.1 (legitimate local Ollama use case)", async () => {
    const u = await assertConfiguredEndpoint("http://localhost:11434");
    expect(u.hostname).toBe("localhost");
    const u2 = await assertConfiguredEndpoint("http://127.0.0.1:11434");
    expect(u2.hostname).toBe("127.0.0.1");
  });

  it("allows private addresses (legitimate self-hosted gateway use case)", async () => {
    const u = await assertConfiguredEndpoint("http://192.168.1.10:8080");
    expect(u.hostname).toBe("192.168.1.10");
  });

  it("allows public HTTPS addresses", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
    const u = await assertConfiguredEndpoint("https://api.example.com/v1");
    expect(u.hostname).toBe("api.example.com");
  });

  it("blocks the 169.254.169.254 cloud metadata address (an SSRF target)", async () => {
    await expect(
      assertConfiguredEndpoint("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/link-local|metadata/i);
  });

  it("blocks other addresses within the 169.254 range", async () => {
    await expect(
      assertConfiguredEndpoint("http://169.254.0.1/"),
    ).rejects.toThrow(/link-local|metadata/i);
  });

  it("blocks hostnames that resolve to link-local (DNS-rebinding-style SSRF)", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "169.254.169.254", family: 4 },
    ] as never);
    await expect(
      assertConfiguredEndpoint("http://evil.example/"),
    ).rejects.toThrow(/link-local/i);
  });

  it("rejects non-http(s) protocols", async () => {
    await expect(assertConfiguredEndpoint("file:///etc/passwd")).rejects.toThrow(
      /http/,
    );
    await expect(
      assertConfiguredEndpoint("javascript:alert(1)"),
    ).rejects.toThrow(/http/);
  });

  it("rejects credentials embedded in the URL", async () => {
    await expect(
      assertConfiguredEndpoint("http://user:pass@localhost:11434/"),
    ).rejects.toThrow(/Credential/i);
  });

  it("blocks the metadata address written as IPv4-mapped IPv6 (::ffff:169.254.169.254)", async () => {
    await expect(
      assertConfiguredEndpoint("http://[::ffff:169.254.169.254]/"),
    ).rejects.toThrow(/link-local|metadata/i);
    await expect(
      assertConfiguredEndpoint("http://[::ffff:a9fe:a9fe]/"),
    ).rejects.toThrow(/link-local|metadata/i);
  });

  it("blocks AWS IMDSv2 over IPv6 ULA (fd00:ec2::254)", async () => {
    await expect(
      assertConfiguredEndpoint("http://[fd00:ec2::254]/latest/meta-data/"),
    ).rejects.toThrow(/link-local|metadata/i);
  });

  it("blocks well-known cloud metadata hostnames", async () => {
    await expect(
      assertConfiguredEndpoint("http://metadata.google.internal/computeMetadata/v1/"),
    ).rejects.toThrow(/metadata/i);
  });

  it("fails closed when DNS resolution fails", async () => {
    vi.spyOn(dns, "lookup").mockRejectedValue(new Error("ENOTFOUND"));
    await expect(
      assertConfiguredEndpoint("http://broken.example/v1"),
    ).rejects.toThrow(/cannot resolve/i);
  });

  it("forbids plaintext http for public hosts (prevents API key leakage)", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
    await expect(
      assertConfiguredEndpoint("http://api.example.com/v1"),
    ).rejects.toThrow(/HTTP is only allowed/i);
  });

  it("allows plaintext http for local/private hosts (legitimate local Ollama use case)", async () => {
    const spy = vi.spyOn(dns, "lookup");
    const u = await assertConfiguredEndpoint("http://localhost:11434");
    expect(u.hostname).toBe("localhost");
    expect(spy).not.toHaveBeenCalled();
  });
});
