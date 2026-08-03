import { createMiddleware } from "langchain";
import path from "node:path";

/**
 * Resolve a thread's working directory. The agent backend factory sets the
 * cwd per thread; we mirror it here so the system prompt can name it. The
 * mapping is populated by AgentManager.setSessionRoot().
 */
const threadRoots = new Map<string, string>();

export function setThreadRoot(threadId: string, root: string): void {
  threadRoots.set(threadId, root);
}
export function getThreadRoot(threadId: string | undefined): string | undefined {
  return threadId ? threadRoots.get(threadId) : undefined;
}

/**
 * Content-block types providers accept on text/user/assistant messages.
 * Streaming tool calls can leave partial blocks (e.g. `input_json_delta`)
 * in checkpointed messages; sending those back to a strict provider
 * (Volcengine Ark) causes "invalid content type" 400s. We strip any block
 * whose type isn't in the allow-list below.
 */
const ALLOWED_CONTENT_TYPES = new Set([
  "text",
  "image_url",
  "video_url",
  "input_audio",
  "audio",
  "file",
  "tool_use",
  "tool_result",
  // Tool call deltas that can appear in streamed AI messages:
  "tool_use_chunk",
]);

/** Partially-typed LangChain message shape we walk. */
interface LcMessage {
  getType?: () => string;
  _getType?: () => string;
  type?: string;
  content?: unknown;
  tool_call_chunks?: unknown;
  tool_calls?: unknown;
}

function sanitizeBlock(block: any): any {
  if (block == null || typeof block !== "object") return block;
  const type = block.type;
  if (typeof type === "string" && !ALLOWED_CONTENT_TYPES.has(type)) {
    // Drop the partial/unsupported block. Keep text if it has any.
    if (typeof block.text === "string" && block.text) {
      return { type: "text", text: block.text };
    }
    return null;
  }
  return block;
}

function sanitizeMessage(msg: any): any {
  if (!msg || typeof msg !== "object") return msg;
  const content = (msg as LcMessage).content;
  if (Array.isArray(content)) {
    const cleaned = content
      .map(sanitizeBlock)
      .filter((b) => b !== null);
    return { ...msg, content: cleaned };
  }
  return msg;
}

/**
 * Middleware that, just before the model is called:
 *  1. injects a per-session working-directory instruction so produced files
 *     land inside <workspace>/<sessionId>/ (not the user's home), and
 *  2. sanitizes message history, removing partial streamed content blocks
 *     (e.g. `input_json_delta`) that strict providers reject.
 */
export function createSanitizeMiddleware() {
  return createMiddleware({
    name: "deepwork_sanitize",
    wrapModelCall: async (request: any, handler: any) => {
      try {
        if (Array.isArray(request?.messages)) {
          request.messages = request.messages.map(sanitizeMessage);
        }
        const threadId: string | undefined =
          request?.config?.configurable?.thread_id;
        const root = threadId ? threadRoots.get(threadId) : undefined;
        if (root) {
          const instruction = [
            `You are working inside this session's folder:`,
            `  ${root}`,
            ``,
            `Rules:`,
            `- When using write_file / edit_file, ALWAYS use a BARE filename or relative path (e.g. "index.html", "src/app.js"), NOT an absolute path and NOT /tmp/... — the sandbox maps the file into this folder automatically.`,
            `- Every file you create lives under this folder. Do not write to /tmp, the user's home, or anywhere else.`,
            `- The folder already exists; do not create it. Run shell commands with relative paths too.`,
          ].join("\n");
          const base =
            typeof request.systemPrompt === "string"
              ? request.systemPrompt
              : "";
          request.systemPrompt = base
            ? `${instruction}\n\n${base}`
            : instruction;
        }
      } catch {
        // Never break a request on sanitization/injection errors.
      }
      return handler(request);
    },
  });
}
