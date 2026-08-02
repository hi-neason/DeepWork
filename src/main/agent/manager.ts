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
        const reasoning = msg.additional_kwargs?.reasoning;
        if (typeof reasoning === "string" && reasoning) {
          emitter.emit("event", { type: "reasoning_delta", text: reasoning });
        }
        if (
          typeof msg.content === "string" &&
          msg.content &&
          (msg.getType?.() === "AIMessageChunk" || msg._getType?.() === "AIMessageChunk")
        ) {
          emitter.emit("event", { type: "message_delta", text: msg.content });
        }
      }
    })();

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (queue.length === 0) {
          const done = await Promise.race([
            consumed.then(() => true, () => true),
            new Promise<boolean>((res) => {
              waiter = () => res(false);
            }),
          ]);
          waiter = null;
          if (done && queue.length === 0) break;
        }
        while (queue.length > 0) yield queue.shift()!;
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
