import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, dialog, shell, app } from "electron";
import path from "node:path";
import fs from "node:fs";
import type { z } from "zod";
import { agentManager } from "../agent/manager";
import { getDb } from "../storage/db";
import { applyOpenAtLogin, setKeepAwake } from "../system";
import { DEEPWORK_ROOT, DEFAULT_WORKSPACE_DIR, sessionRootDir, sessionArtifactsDir, hasPickedWorkspace } from "../config/paths";
import { approvals } from "../security/approvals";
import { verifyModelConfig } from "../agent/model";
import { assertConfiguredEndpoint } from "../tools/webGuard";
import type { Session, Settings } from "../../shared/types";
import { MODEL_CATALOG, PROVIDER_PRESETS } from "../../shared/providers";
import { scheduler } from "../automation/scheduler";
import { terminalManager } from "../terminal/manager";
import i18n from "../i18n";
import {
  loadMcpTrustGrants,
  safeMcpApprovalDetail,
  saveMcpTrustGrants,
  serversRequiringApproval,
} from "../security/mcpTrust";
import {
  artifactActionArgsSchema,
  automationCreateArgsSchema,
  automationCreateSchema,
  automationUpdateArgsSchema,
  assertExistingFileWithin,
  chatSendArgsSchema,
  projectMemoryArgsSchema,
  sessionCreateArgsSchema,
  sessionPermissionModeArgsSchema,
  sessionWorkspaceArgsSchema,
  settingsArgsSchema,
  terminalIdArgsSchema,
  terminalInputArgsSchema,
  terminalResizeArgsSchema,
  terminalSpawnArgsSchema,
} from "./validation";

import {
  listSessions,
  createSession,
  renameSession,
  deleteSession,
  setSessionGroup,
  setSessionWorkspace,
  setSessionModel,
  setSessionPermissionMode,
  normalizeInteractivePermissionMode,
  getSession,
  renameGroup,
  deleteGroup,
  createGroup,
  listGroups,
  groupForWorkspace,
} from "../storage/sessions";
import {
  listSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  renameSkill,
  importSkill,
  exportSkill,
} from "../skills/store";
import {
  loadSettings,
  saveSettings,
  getApiKey,
  setApiKey,
} from "../storage/settings";
import { listAllMemories, listMemoriesByScope, addMemory, removeMemory, searchMemories, editMemory, invalidateMemory, restoreMemory } from "../storage/memories";
import {
  readUserMemory,
  saveUserMemory,
  appendToRecent,
  readRawMemory,
  saveRawMemory,
  MEMORY_FILE,
  MEMORY_SECTIONS,
  type MemorySectionId,
} from "../storage/user-memory";
import {
  listTimelineDates,
  readTimelineDate,
  timelinePath,
} from "../storage/timeline-memory";
import {
  listProjects,
  readProjectMemory,
  projectMemoryPath,
} from "../storage/project-memory";
import {
  listAutomations,
  getAutomation,
  listAutomationsWithRuns,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  listRuns,
  deleteRun,
  deleteRuns,
} from "../storage/automations";
import { logger } from "../log/logger";
import type {
  ApprovalDecision,
  Attachment,
  Automation,
  DeepWorkEvent,
  MemoryType,
  ModelInfo,
  PermissionMode,
  ProviderKind,
  TurnStatus,
  VerifyResult,
} from "../../shared/types";

const MEMORY_TYPES: readonly MemoryType[] = ["preference", "fact", "event"];

/** Strict YYYY-MM-DD guard for timeline date params (C-A3 path traversal). */
const TIMELINE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function assertTimelineDate(date: unknown): asserts date is string {
  if (typeof date !== "string" || !TIMELINE_DATE_RE.test(date)) {
    throw new Error(`Invalid timeline date: ${JSON.stringify(date)}`);
  }
}

/** Coerce an untrusted IPC string into a valid MemoryType, or undefined. */
function asMemoryType(t: string | undefined): MemoryType | undefined {
  return t && (MEMORY_TYPES as readonly string[]).includes(t)
    ? (t as MemoryType)
    : undefined;
}

/**
 * Validate every renderer-supplied service endpoint in a settings blob before
 * it is persisted. A compromised renderer could otherwise save a baseUrl
 * pointing at a link-local/cloud-metadata address and then trigger
 * API-key-bearing requests to it through chat:send. Throws on the first
 * offending URL.
 */
async function assertSettingsEndpoints(s: Settings): Promise<void> {
  const endpoints: string[] = [];
  if (typeof s?.model?.baseUrl === "string" && s.model.baseUrl) {
    endpoints.push(s.model.baseUrl);
  }
  for (const m of s?.configuredModels ?? []) {
    if (typeof m?.baseUrl === "string" && m.baseUrl) endpoints.push(m.baseUrl);
  }
  const embBase = s?.memory?.embedding?.baseUrl;
  if (typeof embBase === "string" && embBase) endpoints.push(embBase);
  for (const server of s?.mcpServers ?? []) {
    if (server.transport === "sse" && server.url) endpoints.push(server.url);
  }
  for (const url of endpoints) {
    await assertConfiguredEndpoint(url);
  }
}

export function registerIpc(getWin: () => BrowserWindow | null): void {
  // Local wrapper around ipcMain.handle that logs each request with its
  // duration and surfaces failures as ERROR lines. This is the single
  // highest-value debug surface for diagnosing "why did X not work". We use an
  // explicit helper instead of monkey-patching ipcMain.handle globally: the
  // patch mutated a shared singleton for the whole process and would double-wrap
  // if registerIpc ever ran twice (L-2).
  const rawHandle = ipcMain.handle.bind(ipcMain);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = (channel: string, listener: (event: any, ...args: any[]) => unknown): void => {
    rawHandle(channel, async (event: unknown, ...args: unknown[]) => {
      const t0 = Date.now();
      try {
        const result = await (listener as (e: unknown, ...a: unknown[]) => unknown)(
          event,
          ...args,
        );
        logger.debug("ipc", "handled", { channel, ms: Date.now() - t0 });
        return result;
      } catch (err) {
        logger.error("ipc", "handle failed", {
          channel,
          error: err instanceof Error ? err.message : String(err),
          ms: Date.now() - t0,
        });
        throw err;
      }
    });
  };

  /** Parse renderer-controlled arguments before they reach a business service. */
  const handleValidated = <S extends z.ZodType<unknown>>(
    channel: string,
    schema: S,
    listener: (event: IpcMainInvokeEvent, args: z.infer<S>) => unknown,
  ): void => {
    handle(channel, (event: unknown, ...args: unknown[]) =>
      listener(event as IpcMainInvokeEvent, schema.parse(args) as z.infer<S>),
    );
  };

  // Forward shell output from the terminal manager to the renderer.
  terminalManager.setSender((channel, ...args) =>
    getWin()?.webContents.send(channel, ...args),
  );

  // Let the agent manager push title updates outside the turn event stream.
  agentManager.setSender((channel, ...args) =>
    getWin()?.webContents.send(channel, ...args),
  );

  // ---- sessions ----
  // listSessions() returns only user-started chats; automation-run transcripts
  // are hidden from the sidebar and resolved on demand via sessions:get when
  // opened from run history.
  handle("sessions:list", () => listSessions());
  handleValidated("sessions:get", terminalIdArgsSchema, (_e, [id]) => getSession(id));
  handleValidated("sessions:create", sessionCreateArgsSchema, (_e, [title, workspaceDir, model, mode]) => {
    const settings = loadSettings();
    return createSession(
      title,
      workspaceDir,
      model,
      "user",
      settings.model?.workspaceDir || DEFAULT_WORKSPACE_DIR,
      mode ?? normalizeInteractivePermissionMode(settings.permissionMode),
    );
  });
  handle("sessions:rename", (_e, id: string, title: string) =>
    renameSession(id, title),
  );
  handle("sessions:delete", (_e, id: string) => {
    // Abort any in-flight turn and drop per-session runtime state before the
    // row is removed, so a deleted session can't leave a turn/emitter behind.
    agentManager.forgetSession(id);
    return deleteSession(id);
  });
  handle("sessions:setGroup", (_e, id: string, group: string) =>
    setSessionGroup(id, group),
  );
  handle("sessions:groups", () => listGroups());
  handleValidated("sessions:setWorkspace", sessionWorkspaceArgsSchema, (_e, [id, workspaceDir]) =>
    setSessionWorkspace(
      id,
      workspaceDir,
      loadSettings().model?.workspaceDir || DEFAULT_WORKSPACE_DIR,
    ),
  );
  handle("sessions:setModel", (_e, id: string, model: string) => {
    setSessionModel(id, model);
    agentManager.setSessionModel(id, model);
  });
  handleValidated(
    "sessions:setPermissionMode",
    sessionPermissionModeArgsSchema,
    (_e, [id, mode]) => {
      setSessionPermissionMode(id, mode);
      agentManager.setSessionMode(id, mode);
    },
  );
  /** Recently used workspace folders (for the new-task folder picker). */
  handle("sessions:recentFolders", () => {
    const rows = getDb()
      .prepare(
        `SELECT workspace_dir, MAX(updated_at) AS latest
         FROM sessions WHERE workspace_dir IS NOT NULL AND workspace_dir != ''
         AND source != 'automation'
         GROUP BY workspace_dir ORDER BY latest DESC LIMIT 8`,
      )
      .all() as Array<{ workspace_dir: string }>;
    return rows.map((r) => ({ path: r.workspace_dir, name: groupForWorkspace(r.workspace_dir) }));
  });
  handle("sessions:renameGroup", (_e, oldName: string, newName: string) =>
    renameGroup(oldName, newName),
  );
  handle("sessions:deleteGroup", (_e, name: string) => deleteGroup(name));
  handle("sessions:createGroup", (_e, name: string) => createGroup(name));

  // ---- skills ----
  handle("skills:list", () => listSkills());
  handle(
    "skills:create",
    (_e, input: { name: string; description?: string; body?: string }) =>
      createSkill(input),
  );
  handle(
    "skills:update",
    (_e, name: string, patch: Record<string, unknown>) =>
      updateSkill(name, patch as Parameters<typeof updateSkill>[1]),
  );
  handle("skills:delete", (_e, name: string) => deleteSkill(name));
  handle(
    "skills:rename",
    (_e, oldName: string, newName: string) => renameSkill(oldName, newName),
  );
  handle(
    "skills:import",
    async (_e, sourceDir: string, newName?: string) => importSkill(sourceDir, newName),
  );
  handle(
    "skills:export",
    async (_e, name: string, targetDir: string) => exportSkill(name, targetDir),
  );
  handle("skills:rebuild", () => agentManager.rebuildSkills());

  // ---- mcp ----
  // Per-server connection status from the last agent build, so the Connectors
  // UI can surface connection failures instead of failing silently (M-storage⑤).
  handle("mcp:status", () => agentManager.getMcpStatus());

  // ---- settings / keys ----
  handle("settings:get", () => loadSettings());
  handleValidated("settings:save", settingsArgsSchema, async (_e, [settings]) => {
    // Validate every renderer-supplied endpoint before it is persisted and can
    // drive credentialed model/embedding requests. The SSRF guard is enforced
    // here (not only in models:verify) so a compromised renderer cannot save a
    // link-local/metadata baseUrl and reach it via chat:send.
    await assertSettingsEndpoints(settings);
    const grants = loadMcpTrustGrants();
    const pending = serversRequiringApproval(settings.mcpServers, grants);
    const approved = new Set<string>();
    for (const server of pending) {
      const options = {
        type: "warning" as const,
        buttons: [i18n.t("common.cancel"), i18n.t("mcpTrust.allow")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: i18n.t("mcpTrust.title"),
        message: i18n.t(
          server.transport === "stdio" ? "mcpTrust.stdioMessage" : "mcpTrust.sseMessage",
          { label: server.label || server.id },
        ),
        detail: `${safeMcpApprovalDetail(server)}\n\n${i18n.t("mcpTrust.warning")}`,
      };
      const win = getWin();
      const result = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
      if (result.response !== 1) {
        throw new Error(i18n.t("mcpTrust.denied"));
      }
      approved.add(server.id);
    }
    // Persist grants before settings: a failed settings write is harmless,
    // while settings without their grant could be rebuilt into an unapproved process.
    saveMcpTrustGrants(settings.mcpServers, approved, grants);
    saveSettings(settings);
  });
  handle("settings:getKey", (_e, provider: ProviderKind) => getApiKey(provider));
  handle("settings:setKey", (_e, provider: ProviderKind, key: string) =>
    setApiKey(provider, key),
  );
  handle("settings:pickDirectory", async () => {
    const win = getWin();
    const res = await dialog.showOpenDialog(win!, {
      properties: ["openDirectory", "createDirectory"],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  handle("settings:rebuildAgent", () => agentManager.rebuild());
  handle("settings:setOnboarded", (_e, onboarded: boolean) => {
    const s = loadSettings();
    s.onboarded = onboarded;
    saveSettings(s);
  });
  handle("settings:applySystem", () => {
    const s = loadSettings();
    applyOpenAtLogin(s.openAtLogin);
    setKeepAwake(s.keepAwake);
  });
  handle("app:revealData", () => {
    shell.openPath(DEEPWORK_ROOT);
  });
  handle("app:dataPath", () => DEEPWORK_ROOT);
  handle("app:version", () => app.getVersion());

  // ---- model catalog / verification ----
  handle("models:catalog", (): ModelInfo[] => MODEL_CATALOG);
  handle("models:providers", () => PROVIDER_PRESETS);
  handle("models:verify", (_e, cfg): Promise<VerifyResult> =>
    verifyModelConfig(cfg),
  );

  // ---- chat ----
  handle("chat:history", async (_e, sessionId: string) => {
    const s = getSession(sessionId);
    // Derive the cwd/sandbox root and output drawer at runtime (works for old
    // sessions whose stored root_dir predates the .deepwork layout).
    const paths = s ? resolveSessionRuntimePaths(s) : undefined;
    agentManager.setSessionRoot(
      sessionId,
      paths?.root,
      paths?.outputDir,
      paths?.isProject,
    );
    agentManager.setSessionModel(sessionId, s?.model);
    agentManager.setSessionMode(sessionId, s?.permissionMode);
    return agentManager.getHistory(sessionId);
  });
  handleValidated("chat:status", terminalIdArgsSchema, (_e, [sessionId]): TurnStatus =>
    agentManager.getTurnStatus(sessionId),
  );

  handleValidated(
    "chat:send",
    chatSendArgsSchema,
    async (event, [sessionId, text, attachments, workspaceDir, modelId, mode]) => {
      const sender = event.sender;
      const push = (e: DeepWorkEvent) => {
        if (!sender.isDestroyed()) sender.send("chat:event", sessionId, e);
      };
      try {
        if (modelId) setSessionModel(sessionId, modelId);
        if (mode) setSessionPermissionMode(sessionId, mode);
        // The agent operates in the session's cwd/sandbox root. For a picked
        // folder that is the folder itself; otherwise the isolated session dir.
        // Derive at runtime so old sessions pick up the new layout.
        const s = getSession(sessionId);
        const paths = s ? resolveSessionRuntimePaths(s) : undefined;
        agentManager.setSessionRoot(
          sessionId,
          paths?.root,
          paths?.outputDir,
          paths?.isProject,
        );
        for await (const e of agentManager.runTurn(
          sessionId,
          text,
          attachments,
          paths?.root,
          modelId,
          s?.permissionMode ?? normalizeInteractivePermissionMode(loadSettings().permissionMode),
        )) {
          push(e);
        }
      } catch (err) {
        push({
          type: "turn_error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  handle("chat:cancel", (_e, sessionId: string) => {
    agentManager.cancel(sessionId);
  });

  handle("chat:regenerate", async (event, sessionId: string) => {
    const sender = event.sender;
    const push = (e: DeepWorkEvent) => {
      if (!sender.isDestroyed()) sender.send("chat:event", sessionId, e);
    };
    try {
      const session = getSession(sessionId);
      agentManager.setSessionMode(sessionId, session?.permissionMode);
      for await (const e of agentManager.regenerate(sessionId)) {
        push(e);
      }
    } catch (err) {
      push({
        type: "turn_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ---- approvals ----
  handle(
    "approval:respond",
    (_e, id: string, decision: ApprovalDecision) => {
      approvals.respond(id, decision);
    },
  );

  // ---- memories ----
  handle("memories:list", (_e, includeInvalid?: boolean) => listAllMemories(includeInvalid === true));
  handle("memories:listByScope", (_e, scopeKey: string, type?: string) =>
    listMemoriesByScope(scopeKey, asMemoryType(type)),
  );
  handle("memories:search", (_e, scopeKey: string, query: string, topK?: number) =>
    searchMemories(scopeKey, query, { topK }),
  );
  handle("memories:add", (_e, content: string, type?: string, scopeKey?: string) =>
    addMemory(content, scopeKey ?? "", { type: asMemoryType(type) }),
  );
  handle("memories:edit", (_e, id: string, content: string) => editMemory(id, content));
  handle("memories:remove", (_e, id: string) => removeMemory(id));
  handle("memories:invalidate", (_e, id: string) => invalidateMemory(id));
  handle("memories:restore", (_e, id: string) => restoreMemory(id));

  // ---- user memory (MD file) ----
  handle("userMemory:read", () => {
    const sections = readUserMemory();
    return Object.fromEntries(sections);
  });
  handle("userMemory:save", (_e, sections: Record<string, string>) => {
    const map = new Map<MemorySectionId, string>();
    for (const [k, v] of Object.entries(sections)) {
      if (MEMORY_SECTIONS.includes(k as MemorySectionId)) {
        map.set(k as MemorySectionId, v);
      }
    }
    saveUserMemory(map);
  });
  handle("userMemory:append", (_e, content: string, source?: string) =>
    appendToRecent(content, source),
  );
  handle("userMemory:raw", () => readRawMemory());
  handle("userMemory:saveRaw", (_e, markdown: string) => saveRawMemory(markdown));
  handle("userMemory:path", () => MEMORY_FILE);

  // ---- timeline memory (per-day markdown) ----
  handle("timeline:list", () => listTimelineDates());
  handle("timeline:read", (_e, date: string) => {
    assertTimelineDate(date);
    return readTimelineDate(date);
  });
  handle("timeline:path", (_e, date: string) => {
    assertTimelineDate(date);
    return timelinePath(date);
  });

  // ---- project memory (per-project markdown) ----
  handle("projectMemory:list", () => listProjects());
  handleValidated("projectMemory:read", projectMemoryArgsSchema, (_e, [project]) => readProjectMemory(project));
  handleValidated("projectMemory:path", projectMemoryArgsSchema, (_e, [project]) => projectMemoryPath(project));

  // ---- artifacts ----
  handle("artifacts:list", (_e, sessionId: string) =>
    agentManager.listArtifacts(sessionId),
  );
  handleValidated("artifacts:reveal", artifactActionArgsSchema, (_e, [sessionId, absolutePath]) => {
    shell.showItemInFolder(resolveSessionArtifact(sessionId, absolutePath));
  });
  handleValidated("artifacts:open", artifactActionArgsSchema, (_e, [sessionId, absolutePath]) =>
    shell.openPath(resolveSessionArtifact(sessionId, absolutePath)),
  );

  // ---- automations ----
  scheduler.init({
    runAutomationTurn: async (sessionId, instructions, onEvent, model, mode) => {
      for await (const e of agentManager.runUnattendedTurn(sessionId, instructions, model, mode)) {
        onEvent(e);
      }
    },
  });
  scheduler.start();
  scheduler.on("run:event", ({ sessionId, event }) => {
    getWin()?.webContents.send("chat:event", sessionId, event);
  });

  handle("automations:list", () => listAutomations());
  handle("automations:listWithRuns", () => listAutomationsWithRuns());
  handleValidated("automations:create", automationCreateArgsSchema, (_e, [automation]) =>
    createAutomation(automation),
  );
  handleValidated("automations:update", automationUpdateArgsSchema, (_e, [id, patch]) => {
      // `handleValidated` has already narrowed this to the mutable partial
      // schema. Persist only the renderer-supplied patch: merging the complete
      // stored Automation here also pulled system-owned fields such as
      // consecutiveFailures/autoPaused into the strict mutable schema.
      updateAutomation(id, patch);
  });
  handle("automations:delete", (_e, id: string) => deleteAutomation(id));
  handle("automations:runs", (_e, id: string) => listRuns(id));
  handle("automations:deleteRun", (_e, runId: string) => deleteRun(runId));
  handle("automations:deleteRuns", (_e, automationId: string) => deleteRuns(automationId));
  handle("automations:runNow", async (_e, id: string) => {
    const a = listAutomations().find((x) => x.id === id);
    if (a) await scheduler.runNow(a);
  });

  // ---- updates (electron-updater is optional; no-op if unavailable) ----
  handle("updates:check", async () => {
    getWin()?.webContents.send("update:status", { state: "checking" });
    try {
      const { autoUpdater } = await import("electron-updater");
      autoUpdater.autoDownload = loadSettings().autoUpdate;
      autoUpdater.removeAllListeners();
      autoUpdater.on("update-available", (info: { version: string }) =>
        getWin()?.webContents.send("update:status", { state: "available", version: info.version }),
      );
      autoUpdater.on("download-progress", (p: { percent: number }) =>
        getWin()?.webContents.send("update:status", { state: "downloading", percent: Math.round(p.percent) }),
      );
      autoUpdater.on("update-downloaded", (info: { version: string }) =>
        getWin()?.webContents.send("update:status", { state: "downloaded", version: info.version }),
      );
      autoUpdater.on("error", (err: Error) =>
        getWin()?.webContents.send("update:status", { state: "error", message: err.message }),
      );
      const result = await autoUpdater.checkForUpdates();
      if (!result || !result.updateInfo) {
        getWin()?.webContents.send("update:status", { state: "not-available" });
      }
    } catch (err) {
      // electron-updater is an optional dependency; in dev/unsigned builds it
      // isn't configured, so surface a non-available state instead of erroring.
      getWin()?.webContents.send("update:status", { state: "not-available" });
    }
  });
  handle("updates:install", async () => {
    try {
      const { autoUpdater } = await import("electron-updater");
      autoUpdater.quitAndInstall();
    } catch {
      // ignore
    }
  });

  // ---- terminal (interactive PTY accessible from the renderer) ----
  handleValidated("terminal:spawn", terminalSpawnArgsSchema, (_e, [id, sessionId]) => {
    const session = getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const { sessionWorkspace } = resolveSessionRuntimePaths(session);
    terminalManager.spawn(id, sessionWorkspace);
  });
  handleValidated("terminal:input", terminalInputArgsSchema, (_e, [id, data]) =>
    terminalManager.input(id, data),
  );
  handleValidated("terminal:resize", terminalResizeArgsSchema, (_e, [id, cols, rows]) =>
    terminalManager.resize(id, cols, rows),
  );
  handleValidated("terminal:kill", terminalIdArgsSchema, (_e, [id]) => terminalManager.kill(id));
}

/**
 * Resolve the authoritative paths shared by the agent, artifact panel, and
 * terminal. Older default sessions may not have their isolated folder because
 * previous versions accidentally created a sibling .deepwork directory. The
 * resulting path is always a main-process-derived session drawer, never a raw
 * renderer-supplied mkdir target.
 */
function resolveSessionRuntimePaths(session: Session): {
  root: string;
  outputDir: string;
  sessionWorkspace: string;
  isProject: boolean;
} {
  const isProject = hasPickedWorkspace(session.workspaceDir);
  const sessionWorkspace =
    session.rootDir ?? sessionRootDir(session.id, session.workspaceDir);
  const root = isProject ? path.resolve(session.workspaceDir!) : sessionWorkspace;
  fs.mkdirSync(sessionWorkspace, { recursive: true });
  return { root, outputDir: sessionWorkspace, sessionWorkspace, isProject };
}

/** Resolve an artifact against the authoritative workspace of its session. */
function resolveSessionArtifact(sessionId: string, candidate: string): string {
  const session = getSession(sessionId);
  if (!session) throw new Error("Session not found");
  const allowedRoot = session.rootDir ?? sessionArtifactsDir(session.id, session.workspaceDir);
  const resolved = assertExistingFileWithin(allowedRoot, candidate);
  const listed = agentManager.listArtifacts(sessionId).some((artifact) => {
    try {
      return fs.realpathSync(artifact.absolutePath) === resolved;
    } catch {
      return false;
    }
  });
  if (!listed) throw new Error("File is not a session artifact");
  return resolved;
}
