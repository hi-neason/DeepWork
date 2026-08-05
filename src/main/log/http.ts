import { logger } from "./logger";

let installed = false;

/**
 * Wrap the main process's global `fetch` so every outbound HTTP request
 * (model API calls, provider key verification, MCP servers, …) is mirrored
 * into the structured log. This catches failures that happen *before* the
 * LangChain callback layer even sees the call — timeouts, DNS errors, provider
 * 5xx — which are otherwise invisible in the agent logs.
 *
 * The wrapper is a thin pass-through: it never reads or consumes the response
 * body (so streaming model responses are unaffected) and only reads the
 * content-length header. No URL query strings, paths with tokens, or headers
 * are logged — only host + pathname + status + timing.
 */
export function installHttpLogging(): void {
  if (installed) return;
  installed = true;
  const orig = globalThis.fetch?.bind(globalThis);
  if (!orig) return;

  const wrap = async (input: any, init?: any): Promise<Response> => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    let host = "";
    let pathname = "";
    try {
      const u = new URL(url);
      host = u.host;
      pathname = u.pathname;
    } catch {
      host = url.slice(0, 64);
    }
    const method = String(init?.method ?? "GET").toUpperCase();
    const t0 = Date.now();
    try {
      const res = await orig(input, init);
      const durationMs = Date.now() - t0;
      const rawLen = res.headers?.get?.("content-length");
      logger.debug("http", "response", {
        method,
        host,
        path: pathname,
        status: res.status,
        durationMs,
        bytes: rawLen ? Number(rawLen) : undefined,
      });
      return res;
    } catch (err) {
      const durationMs = Date.now() - t0;
      logger.error("http", "request_failed", {
        method,
        host,
        path: pathname,
        durationMs,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  (globalThis as unknown as { fetch: typeof fetch }).fetch = wrap as typeof fetch;
}
