import path from "node:path";
import { EventEmitter } from "node:events";
import { app } from "electron";
import { createDeepAgent, LocalShellBackend } from "deepagents";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { DeepAgent } from "deepagents";
import type { StructuredToolInterface } from "@langchain/core/tools";

import { createChatModel } from "./model";
import { createApprovalMiddleware, registerTurnEmitter, unregisterTurnEmitter } from "./middleware";
import { approvals } from "../security/approvals";
import { McpManager } from "../mcp/manager";
import type { HistoryItem } from "../../shared/types";
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
import type { DeepWorkEvent } from "../../shared/types";

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
function extractReasoning(content: unknown, additional: Record<string, unknown> | undefined): string {
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

/**
 * Builds and owns the deepagents agent. Rebuilt when settings (model / MCP /
 * workspace) change. Runs a single turn at a time per session.
 */
export class AgentManager {
  private agent: DeepAgent | null = null;
  private mcp = new McpManager();
  private checkpointer: SqliteSaver | null = null;
  private alwaysAllow = new Set<string>();
  private building: Promise<void> | null = null;

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

    const dbPath = path.join(app.getPath("userData"), "checkpoints.db");
    this.checkpointer = SqliteSaver.fromConnString(dbPath);

    const mcpTools = await this.mcp.buildTools(settings.mcpServers);

    const workspaceDir =
      settings.model.workspaceDir || app.getPath("home");

    // deepagents built-in fs tools: write/edit/execute are write/exec risk.
    annotateRisk("write_file", "write");
    annotateRisk("edit_file", "write");
    annotateRisk("execute", "exec");

    const approvalMiddleware = createApprovalMiddleware(
      () => this.alwaysAllow,
      (name) => this.alwaysAllow.add(name),
    );

    this.agent = createDeepAgent({
      model,
      tools: [...GUI_TOOLS, ...mcpTools] as StructuredToolInterface[],
      backend: new LocalShellBackend({
        rootDir: workspaceDir,
        virtualMode: false,
      }),
      checkpointer: this.checkpointer,
      middleware: [approvalMiddleware],
      systemPrompt: SYSTEM_PROMPT,
      // Lower the very high default (10000) for a desktop assistant.
    });
  }

  async rebuild(): Promise<void> {
    await this.mcp.close();
    this.agent = null;
    this.alwaysAllow.clear();
    await this.ensureAgent();
  }

  /** Run a turn, emitting normalized DeepWorkEvents. */
  async *runTurn(
    sessionId: string,
    userText: string,
  ): AsyncGenerator<DeepWorkEvent> {
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

    const config = {
      configurable: { thread_id: sessionId },
      recursionLimit: 50,
    };

    // Drive the stream in the background. Tool call lifecycle events are
    // emitted by the approval middleware; here we only forward token deltas.
    const consumed = (async () => {
      const stream = await this.agent!.stream(
        { messages: [{ role: "user", content: userText }] },
        { streamMode: "messages", subgraphs: false, ...config },
      );
      for await (const chunk of stream as AsyncIterable<[any, any]>) {
        const [msg] = chunk;
        if (!msg) continue;
        // model.stream() yields AI messages whose getType() is "ai"; LangGraph
        // may also yield "AIMessageChunk". Accept either, ignore others.
        const type = msg.getType?.() ?? msg._getType?.();
        if (type !== "ai" && type !== "AIMessageChunk") continue;

        // Some providers (e.g. Volcengine Ark with extended thinking) stream
        // content as an array of blocks ([{type:"thinking",...},{type:"text",...}])
        // rather than a plain string. Extract both.
        const reasoning = extractReasoning(msg.content, msg.additional_kwargs);
        if (reasoning) {
          emitter.emit("event", { type: "reasoning_delta", text: reasoning });
        }
        const text = extractText(msg.content);
        if (text) {
          emitter.emit("event", { type: "message_delta", text });
        }
      }
    })();

    try {
      // Race-free pump: arm the waiter before deciding to wait, so an event
      // arriving between the queue check and the await is not lost.
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
      yield { type: "turn_completed" };
    } catch (err) {
      yield { type: "turn_error", message: err instanceof Error ? err.message : String(err) };
    } finally {
      emitter.removeListener("event", onEvent);
      unregisterTurnEmitter(sessionId);
    }
  }

  respondApproval(toolCallId: string, decision: "allow" | "deny" | "always_allow"): void {
    approvals.respond(toolCallId, decision);
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
    // DeepAgent's getState typing is narrow; the runtime returns a full state.
    const state: any = await (this.agent as any).getState(config);
    const messages: any[] = state?.values?.messages ?? [];

    const timeline: HistoryItem[] = [];
    const toolResults = new Map<string, string>();
    for (const m of messages) {
      const role = m._getType?.() ?? m.getType?.();
      if (role === "human") {
        timeline.push({ kind: "msg", role: "user", content: stringContent(m.content) });
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
    // Backfill outputs onto tool items that were emitted before their result.
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
    return content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
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
- Use MCP plugin tools for connected services.

Before any mouse/keyboard action, always call screenshot first to see the current
screen and use the coordinates it reports. Coordinates are absolute pixels from
the top-left (0,0). Be precise and conservative — do not click or type unless
you are sure what has focus.

When a task requires a consequential action (writing files, running commands,
network actions, any GUI action), you will be asked to approve it through the
user. Report results concisely.`;

export const agentManager = new AgentManager();
