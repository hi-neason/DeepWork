import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { app } from "electron";
import {
  createDeepAgent,
  LocalShellBackend,
  StateBackend,
  FilesystemBackend,
  createSummarizationMiddleware,
  createSkillsMiddleware,
} from "deepagents";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { RemoveMessage, HumanMessage } from "@langchain/core/messages";
import type { DeepAgent } from "deepagents";
import type { StructuredToolInterface } from "@langchain/core/tools";

import { createChatModel } from "./model";
import { createApprovalMiddleware } from "./middleware";
import { createContextMiddleware } from "./context";
import { registerTurnEmitter, unregisterTurnEmitter } from "./turnEvents";
import { approvals } from "../security/approvals";
import { McpManager } from "../mcp/manager";
import { renameSession } from "../storage/sessions";
import type {
  ArtifactFile,
  Attachment,
  DeepWorkEvent,
  HistoryItem,
} from "../../shared/types";
import { screenshotTool } from "../tools/gui";
import {
  mouseMoveTool,
  mouseClickTool,
  keyboardTypeTool,
  keyboardPressTool,
} from "../tools/control";
import { annotateRisk } from "../tools/registry";
import { loadSettings } from "../storage/settings";
import { touchSession } from "../storage/sessions";
import { WEB_TOOLS } from "../tools/web";
import { createTodosTool } from "../tools/todos";
import { createMemoryTools } from "../tools/memory";
import { skillsSourcePath } from "../skills/store";

const GUI_TOOLS = [
  screenshotTool.tool,
  mouseMoveTool.tool,
  mouseClickTool.tool,
  keyboardTypeTool.tool,
  keyboardPressTool.tool,
];

/** Pull concatenated text from a message content that may be a string or an array of blocks. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") out += block.text;
    }
    return out;
  }
  return "";
}

/** Pull reasoning/thinking text from content blocks or additional_kwargs. */
function extractReasoning(
  content: unknown,
  additional: Record<string, unknown> | undefined,
): string {
  if (typeof additional?.reasoning === "string") return additional.reasoning;
  if (Array.isArray(content)) {
    let out = "";
    for (const block of content) {
      if (
        block &&
        (block.type === "thinking" || block.type === "reasoning") &&
        typeof block.thinking === "string"
      ) {
        out += block.thinking;
      }
    }
    return out;
  }
  return "";
}

/** Turn a user message + attachments into a LangChain multi-block content array. */
function buildUserContent(
  text: string,
  attachments: Attachment[] = [],
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const att of attachments) {
    if (att.kind === "image" && att.dataUrl) {
      blocks.push({ type: "image_url", image_url: { url: att.dataUrl } });
    } else if (att.kind === "pdf" && att.dataUrl) {
      // Anthropic-native PDF document block (works with Anthropic-compatible gateways).
      const base64 = att.dataUrl.includes(",")
        ? att.dataUrl.slice(att.dataUrl.indexOf(",") + 1)
        : att.dataUrl;
      blocks.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: base64,
        },
      });
    } else if (att.text) {
      blocks.push({
        type: "text",
        text: `Attached file: ${att.name}\n\n${att.text}`,
      });
    } else {
      blocks.push({ type: "text", text: `Attached file: ${att.name} (${att.mimeType})` });
    }
  }
  if (text.trim()) blocks.push({ type: "text", text });
  return blocks;
}

/**
 * Builds and owns the deepagents agent. Rebuilt when settings (model / MCP /
 * workspace) change. Runs a single turn at a time per session.
 */
export class AgentManager {
  private agent: DeepAgent | null = null;
  private mcp = new McpManager();
  private checkpointer: SqliteSaver | null = null;
  private alwaysAllow = new Set<string>();
  private titledSessions = new Set<string>();
  private building: Promise<void> | null = null;
  private chatModel: ReturnType<typeof createChatModel> | null = null;
  private aborters = new Map<string, AbortController>();
  /** First-run timestamp per session — used to bound artifact scanning. */
  private sessionStartedAt = new Map<string, number>();
  /** Sessions running without an interactive user (scheduled automations). */
  private unattended = new Set<string>();

  async ensureAgent(): Promise<void> {
    if (this.agent) return;
    if (this.building) return this.building;
    this.building = this._build();
    try {
      await this.building;
    } finally {
      this.building = null;
    }
  }

  private async _build(): Promise<void> {
    const settings = loadSettings();
    const model = createChatModel(settings.model);
    this.chatModel = model;

    const dbPath = path.join(app.getPath("userData"), "checkpoints.db");
    this.checkpointer = SqliteSaver.fromConnString(dbPath);

    const mcpTools = await this.mcp.buildTools(settings.mcpServers);

    const workspaceDir = settings.model.workspaceDir || app.getPath("home");

    // deepagents built-in fs tools: write/edit/execute are write/exec risk.
    annotateRisk("write_file", "write");
    annotateRisk("edit_file", "write");
    annotateRisk("execute", "exec");
    annotateRisk("web_search", "read");
    annotateRisk("web_fetch", "read");
    annotateRisk("remember", "read");
    annotateRisk("forget", "read");
    annotateRisk("list_memories", "read");
    annotateRisk("write_todos", "read");

    const scopeKey = workspaceDir;
    const approvalMiddleware = createApprovalMiddleware({
      getAlwaysAllow: () => this.alwaysAllow,
      onAlwaysAllow: (name) => this.alwaysAllow.add(name),
      getMode: () => loadSettings().permissionMode,
      isUnattended: (threadId) => this.unattended.has(threadId),
    });

    // Auto-compression: when the conversation grows large, old messages are
    // offloaded to an in-state backend and replaced by a summary. This keeps
    // long sessions from blowing the context window.
    const summarization = createSummarizationMiddleware({
      model,
      backend: () => new StateBackend(),
      trigger: { type: "tokens", value: 120_000 },
      keep: { type: "messages", value: 20 },
      trimTokensToSummarize: 4000,
    });

    // Skills: each subdirectory of userData/skills is a SKILL.md, loaded
    // progressively (catalog at startup, full content on demand).
    const skills = createSkillsMiddleware({
      backend: new FilesystemBackend({
        rootDir: skillsSourcePath(),
        virtualMode: true,
      }),
      sources: ["/"],
    });

    const tools: StructuredToolInterface[] = [
      ...GUI_TOOLS,
      ...WEB_TOOLS,
      createTodosTool().tool,
      ...createMemoryTools(scopeKey),
      ...mcpTools,
    ];

    this.agent = createDeepAgent({
      model,
      tools: tools as StructuredToolInterface[],
      backend: new LocalShellBackend({
        rootDir: workspaceDir,
        virtualMode: false,
      }),
      checkpointer: this.checkpointer,
      middleware: [summarization, skills, createContextMiddleware(), approvalMiddleware],
      systemPrompt: SYSTEM_PROMPT,
    });
  }

  async rebuild(): Promise<void> {
    await this.mcp.close();
    this.agent = null;
    this.alwaysAllow.clear();
    await this.ensureAgent();
  }

  /** Request cancellation of an in-flight turn for a session. */
  cancel(sessionId: string): void {
    const ac = this.aborters.get(sessionId);
    if (ac) ac.abort();
    approvals.rejectAll();
  }

  /** Run a turn with no interactive user (e.g. a scheduled automation). */
  async *runUnattendedTurn(
    sessionId: string,
    instructions: string,
  ): AsyncGenerator<DeepWorkEvent> {
    this.unattended.add(sessionId);
    try {
      yield* this.runTurn(sessionId, instructions);
    } finally {
      this.unattended.delete(sessionId);
    }
  }

  /** Run a turn from a new user message. */
  async *runTurn(
    sessionId: string,
    userText: string,
    attachments?: Attachment[],
  ): AsyncGenerator<DeepWorkEvent> {
    const content = buildUserContent(userText, attachments);
    if (!this.sessionStartedAt.has(sessionId)) {
      this.sessionStartedAt.set(sessionId, Date.now());
    }
    const result = yield* this.runStream(sessionId, {
      messages: [{ role: "user", content }],
    });
    // Unlock the input immediately. Title generation is a follow-up model call;
    // do it after turn_completed so the user can type the next message without
    // waiting for the title.
    yield { type: "turn_completed" };
    if (result.aborted) {
      yield { type: "turn_aborted" };
      return;
    }
    if (result.replyText.trim()) {
      const title = await this.maybeGenerateTitle(sessionId, userText, result.replyText);
      if (title) yield { type: "session_renamed", title };
    }
    // Surface any artifacts produced in the workspace during this session.
    const artifacts = this.collectArtifacts(sessionId);
    if (artifacts.length) yield { type: "artifacts_updated", artifacts };
  }

  /**
   * Core streaming loop. Invokes the agent with the given input, normalizes
   * token/tool events into DeepWorkEvents, and resolves with the assistant's
   * aggregated reply text.
   */
  private async *runStream(
    sessionId: string,
    input: Record<string, unknown>,
  ): AsyncGenerator<DeepWorkEvent, { replyText: string; aborted: boolean }, void> {
    await this.ensureAgent();
    if (!this.agent) throw new Error("Agent not initialized");

    const emitter = new EventEmitter();
    registerTurnEmitter(sessionId, emitter);

    const queue: DeepWorkEvent[] = [];
    let waiter: ((() => void) | null) = null;
    const onEvent = (e: DeepWorkEvent) => {
      queue.push(e);
      waiter?.();
    };
    emitter.on("event", onEvent);

    const ac = new AbortController();
    this.aborters.set(sessionId, ac);
    const config = {
      configurable: { thread_id: sessionId },
      recursionLimit: 50,
      signal: ac.signal,
    };

    let replyText = "";
    let aborted = false;
    const consumed = (async () => {
      const stream = await this.agent!.stream(input, {
        streamMode: "messages",
        subgraphs: false,
        ...config,
      });
      for await (const chunk of stream as AsyncIterable<[any, any]>) {
        const [msg] = chunk;
        if (!msg) continue;
        const type = msg.getType?.() ?? msg._getType?.();
        if (type !== "ai" && type !== "AIMessageChunk") continue;
        const reasoning = extractReasoning(msg.content, msg.additional_kwargs);
        if (reasoning) {
          emitter.emit("event", { type: "reasoning_delta", text: reasoning });
        }
        const text = extractText(msg.content);
        if (text) {
          replyText += text;
          emitter.emit("event", { type: "message_delta", text });
        }
      }
    })();

    try {
      // Race-free pump: arm the waiter before deciding to wait.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        let resolveWait: (v: false) => void = () => {};
        waiter = () => resolveWait(false);
        const done = await Promise.race([
          consumed.then(() => true),
          new Promise<false>((res) => {
            resolveWait = res;
          }),
        ]);
        waiter = null;
        if (done && queue.length === 0) break;
      }
      await consumed;
      touchSession(sessionId);
    } catch (err) {
      if (ac.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        aborted = true;
      } else {
        yield {
          type: "turn_error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    } finally {
      this.aborters.delete(sessionId);
      emitter.removeListener("event", onEvent);
      unregisterTurnEmitter(sessionId);
    }
    return { replyText, aborted };
  }

  respondApproval(toolCallId: string, decision: "allow" | "deny" | "always_allow"): void {
    approvals.respond(toolCallId, decision);
  }

  /**
   * Regenerate: drop the last human message and everything after it from the
   * checkpointer, then re-send that human message for a fresh response.
   */
  async *regenerate(sessionId: string): AsyncGenerator<DeepWorkEvent> {
    await this.ensureAgent();
    if (!this.agent) throw new Error("Agent not initialized");
    const config = { configurable: { thread_id: sessionId } };
    const state: any = await (this.agent as any).getState(config);
    const messages: any[] = state?.values?.messages ?? [];
    let lastHuman = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const t = messages[i]._getType?.() ?? messages[i].getType?.();
      if (t === "human") {
        lastHuman = i;
        break;
      }
    }
    if (lastHuman < 0) {
      yield { type: "turn_error", message: "Nothing to regenerate." };
      return;
    }
    const lastHumanMsg = messages[lastHuman];
    const humanContent = lastHumanMsg.content;
    const toRemove = messages
      .slice(lastHuman)
      .filter((m) => m?.id)
      .map((m) => new RemoveMessage({ id: m.id }));
    if (toRemove.length > 0) {
      await (this.agent as any).updateState(config, { messages: toRemove });
    }
    const result = yield* this.runStream(sessionId, {
      messages: [new HumanMessage(humanContent)],
    });
    yield { type: "turn_completed" };
    if (result.aborted) yield { type: "turn_aborted" };
  }

  /**
   * Generate a short title for a session after its first exchange. Runs once per
   * session; the prompt asks for the user's language and a plain title without
   * quotes/punctuation. Best effort — failures are swallowed.
   */
  private async maybeGenerateTitle(
    sessionId: string,
    userText: string,
    assistantReply: string,
  ): Promise<string | null> {
    if (this.titledSessions.has(sessionId)) return null;
    this.titledSessions.add(sessionId);
    if (!this.chatModel) return null;
    try {
      const prompt =
        "Summarize the following conversation as a short title of at most 6 words. " +
        "Write it in the same language as the user's message. " +
        "Return ONLY the title text, no quotes, no punctuation, no explanation.\n\n" +
        `User: ${userText.slice(0, 500)}\nAssistant: ${assistantReply.slice(0, 500)}`;
      const res = await this.chatModel.invoke(prompt);
      const raw =
        typeof res.content === "string"
          ? res.content
          : res.content
              .filter((b: any) => b?.type === "text")
              .map((b: any) => b.text)
              .join(" ");
      const title = raw
        .trim()
        .replace(/^["'\s]+|["'\s]+$/g, "")
        .replace(/\s+/g, " ")
        .slice(0, 60);
      if (!title) return null;
      renameSession(sessionId, title);
      return title;
    } catch (err) {
      console.info("Title generation failed:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Best-effort scan of the workspace for files modified since this session's
   * run started (capped). Skips scanning the home directory directly to avoid
   * enumerating tens of thousands of files.
   */
  private collectArtifacts(sessionId?: string): ArtifactFile[] {
    const settings = loadSettings();
    const root = settings.model.workspaceDir;
    if (!root || root === app.getPath("home")) return [];
    const since =
      (sessionId ? this.sessionStartedAt.get(sessionId) : undefined) ?? Date.now();
    const out: ArtifactFile[] = [];
    const skip = new Set(["node_modules", ".git", ".venv", "dist", "build", "out"]);
    const walk = (dir: string, depth: number): void => {
      if (depth > 3 || out.length > 200) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (skip.has(e.name) || e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full, depth + 1);
        } else if (e.isFile()) {
          let st: fs.Stats;
          try {
            st = fs.statSync(full);
          } catch {
            continue;
          }
          if (st.mtimeMs >= since) {
            out.push({
              name: e.name,
              relativePath: path.relative(root, full),
              absolutePath: full,
              size: st.size,
              modifiedAt: st.mtimeMs,
              ext: path.extname(e.name).replace(".", "").toLowerCase(),
            });
          }
        }
      }
    };
    walk(root, 0);
    return out.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 100);
  }

  /**
   * Reconstruct a coarse chat timeline from the persisted checkpointer state
   * for a thread, so switching sessions shows prior messages. Tool call/result
   * pairs are collapsed into a single tool record.
   */
  async getHistory(sessionId: string): Promise<{ timeline: HistoryItem[] }> {
    await this.ensureAgent();
    if (!this.agent) return { timeline: [] };
    const config = { configurable: { thread_id: sessionId } };
    const state: any = await (this.agent as any).getState(config);
    const messages: any[] = state?.values?.messages ?? [];

    const timeline: HistoryItem[] = [];
    const toolResults = new Map<string, string>();
    for (const m of messages) {
      const role = m._getType?.() ?? m.getType?.();
      if (role === "human") {
        const content = stringContent(m.content);
        if (content) timeline.push({ kind: "msg", role: "user", content });
      } else if (role === "ai" || role === "AIMessageChunk") {
        const text = stringContent(m.content);
        if (text) timeline.push({ kind: "msg", role: "assistant", content: text });
        for (const tc of m.tool_calls ?? []) {
          if (!tc?.id) continue;
          timeline.push({
            kind: "tool",
            id: tc.id,
            name: tc.name,
            argsPreview: preview(tc.args),
            status: "done" as const,
            outputPreview: toolResults.get(tc.id),
          });
        }
      } else if (role === "tool") {
        if (m.tool_call_id) toolResults.set(m.tool_call_id, preview(m.content));
      }
    }
    for (const item of timeline) {
      if (item.kind === "tool" && item.id && !item.outputPreview) {
        const out = toolResults.get(item.id);
        if (out) item.outputPreview = out;
      }
    }
    return { timeline };
  }
}

function stringContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // For history, render document/image blocks as a short marker instead of dropping.
    return content
      .map((b) => {
        if (b?.type === "text" && typeof b.text === "string") return b.text;
        if (b?.type === "image_url") return "[image]";
        if (b?.type === "document") return "[document]";
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

function preview(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
  } catch {
    return String(v);
  }
}

const SYSTEM_PROMPT = `You are DeepWork, a local-first personal desktop AI assistant.

You can accomplish tasks on this computer using tools:
- Read, write, edit and search files; run shell commands.
- See the screen with "screenshot", then operate the GUI with mouse/keyboard tools.
  GUI tools are a fallback — prefer file/shell/MCP tools when available.
- Search the public web with "web_search" and read pages with "web_fetch".
- Remember durable facts about the user with "remember" / "forget" / "list_memories".
- Track multi-step work with "write_todos" so the user can see progress.
- Use MCP plugin tools for connected services.

Before any mouse/keyboard action, always call screenshot first to see the current
screen and use the coordinates it reports. Coordinates are absolute pixels from
the top-left (0,0). Be precise and conservative — do not click or type unless
you are sure what has focus.

When you create deliverables (documents, code, reports, data files), save them
into the workspace and mention the file paths in your final reply so the user
can open them from the artifacts panel.

When a task requires a consequential action (writing files, running commands,
network actions, any GUI action), you will be asked to approve it through the
user. For complex tasks, first write_todos as a plan, then execute step by step.
Report results concisely.`;

export const agentManager = new AgentManager();
