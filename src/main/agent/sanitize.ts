import { createMiddleware } from "langchain";
import path from "node:path";

/**
 * Per-thread working context. The agent backend factory sets the cwd per
 * thread; we mirror it here so the system prompt can name it. The mapping is
 * populated by AgentManager.setSessionRoot().
 *
 *  cwd       agent cwd / fs-sandbox root (the chosen project folder, or an
 *            isolated default-workspace session folder)
 *  outputDir where produced deliverables must be written (for a picked folder
 *            this is <cwd>/.deepwork/sessions/<id>/; otherwise it equals cwd)
 *  isProject true when the user explicitly picked a folder (source is readable)
 */
interface ThreadWorkspace {
  cwd: string;
  outputDir?: string;
  isProject?: boolean;
}

const threadRoots = new Map<string, ThreadWorkspace>();

export function setThreadRoot(
  threadId: string,
  cwd: string,
  outputDir?: string,
  isProject?: boolean,
): void {
  if (cwd) {
    threadRoots.set(threadId, { cwd, outputDir, isProject });
  } else {
    threadRoots.delete(threadId);
  }
}
export function getThreadRoot(threadId: string | undefined): string | undefined {
  return threadId ? threadRoots.get(threadId)?.cwd : undefined;
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

function buildInstruction(ws: ThreadWorkspace): string {
  const lines: string[] = [];
  if (ws.isProject) {
    // Picked a real project folder: it is both cwd and the fs-sandbox boundary.
    lines.push(
      `Project workspace (your working directory and sandbox root):`,
      `  ${ws.cwd}`,
      ``,
      `Rules:`,
      `- This folder is the user's project. You may read its source files to understand the project.`,
      `- Filesystem tools can only access files inside this folder; ".." traversal and absolute paths outside it are rejected.`,
      `- When using write_file / edit_file, ALWAYS use a relative path from the workspace root (e.g. "src/app.js"). NEVER write absolute paths or /tmp/... paths.`,
    );
    if (ws.outputDir) {
      const rel = path.relative(ws.cwd, ws.outputDir) || ".";
      lines.push(
        `- Save ALL deliverables you produce (reports, generated code, documents, data files) into this session's output folder, relative to the workspace:`,
        `    ${rel}/`,
        `- The ".deepwork/" directory is DeepWork's own data directory. Ignore it when analyzing the project source; never treat it as project code.`,
      );
    }
    lines.push(
      `- The working directory already exists; do not recreate it. Run shell commands from here (use relative paths).`,
    );
  } else {
    // Default isolated session folder (no project picked).
    lines.push(
      `You are working inside this session's folder:`,
      `  ${ws.cwd}`,
      ``,
      `Rules:`,
      `- When using write_file / edit_file, ALWAYS use a BARE filename or relative path (e.g. "index.html"), NOT an absolute path and NOT /tmp/... — the sandbox maps the file into this folder automatically.`,
      `- Every file you create lives under this folder. Do not write to /tmp, the user's home, or anywhere else.`,
      `- The folder already exists; do not create it. Run shell commands with relative paths too.`,
    );
  }
  return lines.join("\n");
}

/**
 * Middleware that, just before the model is called:
 *  1. injects a per-session working-directory instruction so the model knows
 *     its project root and where produced files must land, and
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
        const ws = threadId ? threadRoots.get(threadId) : undefined;
        if (ws?.cwd) {
          const instruction = buildInstruction(ws);
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
