import net from "node:net";
import dns from "node:dns/promises";

/**
 * SSRF guard: block requests to loopback, private, link-local and other
 * non-public addresses so the agent can't reach cloud metadata endpoints or
 * local services via web_fetch.
 *
 * Three layers:
 *  1. Literal parsing — dotted, decimal, octal and hex IPv4 forms plus IPv6
 *     (including IPv4-mapped `::ffff:127.0.0.1`) are normalized before the
 *     range check, so `http://2130706433/` can't smuggle 127.0.0.1 through.
 *  2. DNS resolution — hostnames are resolved and *every* returned address
 *     must be public, which closes the `169.254.169.254.nip.io` style bypass.
 *  3. Per-hop re-validation — callers must re-run the check on each redirect.
 *
 * Residual risk: a DNS rebinding race between our lookup and the socket
 * connect is still theoretically possible (we cannot pin the resolved IP onto
 * fetch's socket without reimplementing the HTTP client). Every hop being
 * re-resolved keeps the window small.
 */

/** Strict integer parse for one IPv4 part: decimal, 0x-hex or 0-octal. */
function parseIPv4Part(part: string): number | null {
  if (part === "") return null;
  let value: number;
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
    value = parseInt(part.slice(2), 16);
  } else if (/^0[0-7]+$/.test(part)) {
    value = parseInt(part.slice(1), 8);
  } else if (/^[0-9]+$/.test(part)) {
    value = parseInt(part, 10);
  } else {
    return null;
  }
  return Number.isFinite(value) ? value : null;
}

/**
 * Normalize any legacy IPv4 notation to a dotted quad, mirroring the WHATWG
 * URL host parser: `2130706433`, `0x7f000001`, `0177.0.0.1` and `127.1` all
 * resolve to 127.0.0.1. Returns null when the input is not an IPv4 literal.
 */
export function normalizeIPv4(host: string): string | null {
  const parts = host.split(".");
  // A trailing dot is allowed ("127.0.0.1.").
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const n = parseIPv4Part(p);
    if (n === null) return null;
    nums.push(n);
  }
  // All parts except the last must fit in one byte; the last absorbs the rest.
  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i] > 255) return null;
  }
  const last = nums[nums.length - 1];
  const maxLast = 256 ** (4 - (nums.length - 1));
  if (last >= maxLast) return null;
  let value = last;
  for (let i = 0; i < nums.length - 1; i++) {
    value += nums[i] * 256 ** (3 - i);
  }
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join(".");
}

/** Expand an IPv6 literal into its eight 16-bit groups (null if malformed). */
function expandIPv6(input: string): number[] | null {
  let addr = input.toLowerCase();
  // Zone id (fe80::1%en0) is irrelevant to the range check.
  const pct = addr.indexOf("%");
  if (pct !== -1) addr = addr.slice(0, pct);
  // A trailing dotted-quad ("::ffff:127.0.0.1") becomes two 16-bit groups.
  const lastColon = addr.lastIndexOf(":");
  const tail = addr.slice(lastColon + 1);
  if (tail.includes(".")) {
    const quad = normalizeIPv4(tail);
    if (!quad) return null;
    const b = quad.split(".").map(Number);
    addr =
      addr.slice(0, lastColon + 1) +
      ((b[0] << 8) | b[1]).toString(16) +
      ":" +
      ((b[2] << 8) | b[3]).toString(16);
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] =>
    s === "" ? [] : s.split(":").map((g) => parseInt(g, 16));
  const head = toGroups(halves[0]);
  const tailGroups = halves.length === 2 ? toGroups(halves[1]) : [];
  if ([...head, ...tailGroups].some((g) => !Number.isFinite(g))) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tailGroups.length;
  if (fill < 0) return null;
  return [...head, ...new Array(fill).fill(0), ...tailGroups];
}

/** Range check for a dotted-quad IPv4 address. */
function isPublicIPv4(quad: string): boolean {
  const p = quad.split(".").map(Number);
  if (p[0] === 0) return false; // 0.0.0.0/8 "this network"
  if (p[0] === 10) return false; // private
  if (p[0] === 127) return false; // loopback
  if (p[0] === 169 && p[1] === 254) return false; // link-local / cloud metadata
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false; // private
  if (p[0] === 192 && p[1] === 168) return false; // private
  if (p[0] === 192 && p[1] === 0 && p[2] === 0) return false; // IETF protocol
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false; // CGNAT
  if (p[0] >= 224) return false; // multicast + reserved + broadcast
  return true;
}

/**
 * Classify a raw IP literal (v4 or v6, any notation). IPv4-mapped and
 * IPv4-compatible IPv6 addresses are folded down to their IPv4 form first so
 * `::ffff:127.0.0.1` can't slip past the v4 range table.
 */
export function isPublicIp(ip: string): boolean {
  const h = ip.replace(/^\[|\]$/g, "");
  const quad = normalizeIPv4(h);
  if (quad) return isPublicIPv4(quad);
  const groups = expandIPv6(h);
  if (!groups) return false; // not parseable → refuse rather than allow
  const isZeroPrefix = groups.slice(0, 5).every((g) => g === 0);
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated).
  if (isZeroPrefix && (groups[5] === 0xffff || groups[5] === 0)) {
    const v4 = [
      (groups[6] >> 8) & 0xff,
      groups[6] & 0xff,
      (groups[7] >> 8) & 0xff,
      groups[7] & 0xff,
    ].join(".");
    // `::` and `::1` fold to 0.0.0.0 / 0.0.0.1, both already non-public.
    return isPublicIPv4(v4);
  }
  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (first === 0x0064 && groups[1] === 0xff9b) return false; // 64:ff9b::/96 NAT64
  if (first === 0x0100 && groups[1] === 0) return false; // 100::/64 discard
  return true;
}

/**
 * Literal (synchronous) host check. Does NOT resolve DNS — use
 * `assertPublicUrlResolved` for anything that actually opens a connection.
 */
export function isPublicHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return false;
  // Any IP literal (dotted, decimal, hex, octal, IPv6) is classified directly.
  if (net.isIP(h) || normalizeIPv4(h) !== null || h.includes(":")) {
    return isPublicIp(h);
  }
  // Internal-only TLDs never point at the public internet.
  if (
    h.endsWith(".internal") ||
    h.endsWith(".local") ||
    h.endsWith(".home.arpa") ||
    h.endsWith(".localdomain")
  ) {
    return false;
  }
  return true;
}

/** Parse + protocol + literal-host validation. Throws on anything suspicious. */
export function assertPublicUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http/https URLs are allowed (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new Error("Credentials in URLs are not allowed");
  }
  if (!isPublicHost(url.hostname)) {
    throw new Error(`Blocked request to non-public host: ${url.hostname}`);
  }
  return url;
}

/**
 * Validate a user-configured service endpoint (model base URL, embedding base
 * URL). Unlike `assertPublicUrl`, loopback/private hosts ARE allowed — local
 * Ollama and self-hosted gateways are legitimate — but link-local/cloud
 * metadata addresses (169.254.169.254 and the 169.254.0.0/16 range) are
 * blocked because they are the canonical SSRF target for credential theft from
 * a compromised renderer. DNS is resolved so a public hostname that resolves
 * to link-local can't bypass the literal check.
 */
export async function assertConfiguredEndpoint(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http/https URLs are allowed (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new Error("Credentials in URLs are not allowed");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // Literal IP: allow loopback/private, block only link-local (169.254/16,
  // fe80::/10) which is where cloud metadata endpoints live.
  if (net.isIP(host) || normalizeIPv4(host) !== null) {
    const ip = normalizeIPv4(host) ?? host;
    if (isLinkLocalLiteral(ip)) {
      throw new Error(`Blocked request to link-local/metadata host: ${host}`);
    }
    return url;
  }
  // Hostname: resolve and require that NO address is link-local. A hostname
  // that resolves to both public and 169.254 is still an SSRF vector.
  let records: { address: string }[];
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    // Resolution failure falls through — let fetch produce its own error rather
    // than blocking a hostname that may resolve via a different resolver.
    return url;
  }
  for (const r of records) {
    if (isLinkLocalLiteral(r.address)) {
      throw new Error(
        `Blocked request: ${host} resolves to link-local address ${r.address}`,
      );
    }
  }
  return url;
}

/** True for 169.254.0.0/16 (IPv4 link-local / cloud metadata) or fe80::/10. */
function isLinkLocalLiteral(ip: string): boolean {
  const quad = normalizeIPv4(ip);
  if (quad) {
    const p = quad.split(".").map(Number);
    return p[0] === 169 && p[1] === 254;
  }
  const groups = expandIPv6(ip);
  if (!groups) return false;
  const first = groups[0];
  return (first & 0xffc0) === 0xfe80; // fe80::/10
}

/**
 * Full guard: literal checks plus DNS resolution, requiring *every* resolved
 * address to be public. This is what closes the "public hostname that resolves
 * to 127.0.0.1 / 169.254.169.254" bypass. Call it for every redirect hop.
 */
export async function assertPublicUrlResolved(rawUrl: string): Promise<URL> {
  const url = assertPublicUrl(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // Literals were already classified; no DNS involved.
  if (net.isIP(host) || normalizeIPv4(host) !== null) return url;

  let records: { address: string }[];
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`Blocked request: cannot resolve host ${host}`);
  }
  if (records.length === 0) {
    throw new Error(`Blocked request: host ${host} has no addresses`);
  }
  for (const r of records) {
    if (!isPublicIp(r.address)) {
      throw new Error(
        `Blocked request to non-public host: ${host} resolves to ${r.address}`,
      );
    }
  }
  return url;
}

/** Strip HTML down to readable text without any external dependency. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gis, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gis, " ")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gis, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
