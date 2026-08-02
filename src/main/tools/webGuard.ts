import net from "node:net";

/**
 * SSRF guard: block requests to loopback, private, link-local and other
 * non-public addresses so the agent can't reach cloud metadata endpoints or
 * local services via web_fetch. Every redirect hop is re-checked.
 */
export function isPublicHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
  // Strip IPv6 brackets.
  const h = hostname.replace(/^\[|\]$/g, "");
  // If it's an IP literal, classify it directly.
  if (net.isIP(h)) {
    if (net.isIPv4(h)) {
      const parts = h.split(".").map(Number);
      if (parts[0] === 10) return false;
      if (parts[0] === 127) return false;
      if (parts[0] === 0) return false;
      if (parts[0] === 169 && parts[1] === 254) return false; // link-local / metadata
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
      if (parts[0] === 192 && parts[1] === 168) return false;
      if (parts[0] >= 224) return false; // multicast/reserved
      if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return false; // CGNAT
      return true;
    }
    // IPv6: loopback ::1, link-local fe80::/10, unique local fc00::/7.
    const lower = h.toLowerCase();
    if (lower === "::1" || lower === "::") return false;
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return false;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return false;
    return true;
  }
  // Hostnames are allowed; DNS resolution is the caller's responsibility if
  // they want to also block private-IP DNS answers. We only block obvious
  // internal TLDs.
  if (h.endsWith(".internal") || h.endsWith(".local")) return false;
  return true;
}

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
  if (!isPublicHost(url.hostname)) {
    throw new Error(`Blocked request to non-public host: ${url.hostname}`);
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
