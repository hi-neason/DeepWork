import { z } from "zod";
import { defineTool } from "./registry";
import { assertPublicUrl, htmlToText } from "./webGuard";

const MAX_FETCH_CHARS = 12_000;

/**
 * Web search via DuckDuckGo's HTML endpoint (no API key required). We parse
 * the result links out of the lightweight HTML page. This is a best-effort
 * default; users can plug in a richer search via MCP if needed.
 */
export const webSearchTool = defineTool(
  "read",
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
  "read",
  async ({ url: rawUrl, max_chars }) => {
    let current = assertPublicUrl(rawUrl).toString();
    const max = Math.min(Math.max(max_chars ?? MAX_FETCH_CHARS, 500), 40_000);
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(current, {
        redirect: "manual",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return `Redirect (${res.status}) with no location`;
        current = assertPublicUrl(new URL(loc, current).toString()).toString();
        continue;
      }
      if (!res.ok) return `Fetch failed: HTTP ${res.status}`;
      const contentType = res.headers.get("content-type") ?? "";
      const finalUrl = current;
      if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
        const html = await res.text();
        const text = htmlToText(html);
        return `Contents of ${finalUrl}:\n\n${text.slice(0, max)}${
          text.length > max ? "\n\n[truncated…]" : ""
        }`;
      }
      if (contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml")) {
        const text = await res.text();
        return `Contents of ${finalUrl} (${contentType}):\n\n${text.slice(0, max)}${
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
