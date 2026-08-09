import { z } from "zod";
import { defineTool } from "./registry";
import { assertPublicUrlResolved, htmlToText } from "./webGuard";

const MAX_FETCH_CHARS = 12_000;
/** Hard cap on the response body size (bytes) before text extraction. */
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
/** Per-hop request timeout (connect + headers + body). */
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

/**
 * Web search via DuckDuckGo's HTML endpoint (no API key required). We parse
 * the result links out of the lightweight HTML page. This is a best-effort
 * default; users can plug in a richer search via MCP if needed.
 */
export const webSearchTool = defineTool(
  "external",
  async ({ query, max_results }) => {
    const limit = Math.min(Math.max(max_results ?? 8, 1), 20);
    const url = new URL("https://html.duckduckgo.com/html/");
    url.searchParams.set("q", query);
    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html",
      },
    });
    if (!res.ok) return `Search failed: HTTP ${res.status}`;
    const html = await res.text();

    const results: { title: string; url: string; snippet: string }[] = [];
    // DuckDuckGo HTML result anchors look like:
    // <a class="result__a" href="//duckduckgo.com/l/?uddg=ENCODED&...">title</a>
    const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const snippets: string[] = [];
    let sm: RegExpExecArray | null;
    while ((sm = snippetRe.exec(html)) !== null) {
      snippets.push(stripTags(sm[1]));
    }
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = linkRe.exec(html)) !== null && results.length < limit) {
      const href = decodeDuckHref(m[1]);
      if (!href || href.includes("duckduckgo.com/y.js")) continue;
      results.push({
        title: stripTags(m[2]),
        url: href,
        snippet: snippets[i] ?? "",
      });
      i++;
    }
    if (results.length === 0) {
      return `No results for "${query}".`;
    }
    return results
      .map((r, idx) => `${idx + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n");
  },
  {
    name: "web_search",
    description:
      "Search the public web and return a list of result titles, URLs and snippets. Use this for up-to-date information, documentation and facts you are unsure about.",
    schema: z.object({
      query: z.string().describe("Search query"),
      max_results: z.number().optional().describe("Max number of results (1-20)"),
    }),
  },
);

/**
 * Fetch a public web page and return its text. Refuses non-public (loopback,
 * private, link-local) hosts to prevent SSRF. Follows up to 4 redirects,
 * re-checking each destination.
 */
export const webFetchTool = defineTool(
  "external",
  async ({ url: rawUrl, max_chars }) => {
    // Resolve + range-check before the first hop, and again for every redirect
    // target below — a public entry URL must not be able to bounce us into the
    // private network (C-T1 / C-T2).
    let current = (await assertPublicUrlResolved(rawUrl)).toString();
    const max = Math.min(Math.max(max_chars ?? MAX_FETCH_CHARS, 500), 40_000);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Per-hop timeout so a slow/hung server can't stall the agent turn.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
          },
        });
      } catch (err) {
        return `Fetch failed: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        clearTimeout(timer);
      }
      if (res.status >= 300 && res.status < 400) {
        if (hop === MAX_REDIRECTS) return "Too many redirects.";
        const loc = res.headers.get("location");
        if (!loc) return `Redirect (${res.status}) with no location`;
        current = (
          await assertPublicUrlResolved(new URL(loc, current).toString())
        ).toString();
        continue;
      }
      if (!res.ok) return `Fetch failed: HTTP ${res.status}`;
      const contentType = res.headers.get("content-type") ?? "";
      const finalUrl = current;
      // Bound the body size so a huge/oversized response can't OOM the process.
      const clHeader = res.headers.get("content-length");
      if (clHeader && Number(clHeader) > MAX_FETCH_BYTES) {
        return `Fetched ${finalUrl} but body too large (${clHeader} bytes).`;
      }
      if (
        contentType.includes("text/html") ||
        contentType.includes("application/xhtml") ||
        contentType.startsWith("text/") ||
        contentType.includes("json") ||
        contentType.includes("xml")
      ) {
        const html = await readBoundedText(res, MAX_FETCH_BYTES);
        if (html === null) {
          return `Fetched ${finalUrl} but body exceeded ${MAX_FETCH_BYTES} bytes.`;
        }
        const isHtml =
          contentType.includes("html") || contentType.includes("xhtml");
        const text = isHtml ? htmlToText(html) : html;
        return `Contents of ${finalUrl}:\n\n${text.slice(0, max)}${
          text.length > max ? "\n\n[truncated…]" : ""
        }`;
      }
      return `Fetched ${finalUrl} but unsupported content-type: ${contentType || "unknown"}`;
    }
    return "Too many redirects.";
  },
  {
    name: "web_fetch",
    description:
      "Fetch a public HTTP(S) URL and return its page text. Use for reading documentation/pages found with web_search. Private/local hosts are blocked.",
    schema: z.object({
      url: z.string().describe("Absolute http(s) URL to fetch"),
      max_chars: z.number().optional().describe("Max characters to return"),
    }),
  },
);

/** Read a response body as text, aborting if it exceeds `maxBytes`. */
async function readBoundedText(
  res: Response,
  maxBytes: number,
): Promise<string | null> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return null;
      }
      chunks.push(value);
    }
  }
  return new TextDecoder().decode(concatChunks(chunks));
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Decode a DuckDuckGo redirect href to the real destination (if present). */
function decodeDuckHref(href: string): string {
  if (href.startsWith("//")) href = "https:" + href;
  try {
    const u = new URL(href);
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return u.hostname.includes("duckduckgo.com") ? "" : u.toString();
  } catch {
    return "";
  }
}

import type { ToolInterface } from "@langchain/core/tools";

export const WEB_TOOLS: ToolInterface[] = [webSearchTool.tool, webFetchTool.tool];
