import { ipcMain, type BrowserWindow, dialog, shell, app } from "electron";
import path from "node:path";
import fs from "node:fs";
import { agentManager } from "../agent/manager";
import { getDb } from "../storage/db";
import { applyOpenAtLogin, setKeepAwake } from "../system";
import { DEEPWORK_ROOT, sessionRootDir, sessionArtifactsDir, hasPickedWorkspace } from "../config/paths";
import { approvals } from "../security/approvals";
import { verifyModelConfig } from "../agent/model";
import { MODEL_CATALOG, PROVIDER_PRESETS } from "../../shared/providers";
import { scheduler } from "../automation/scheduler";
import { terminalManager } from "../terminal/manager";

import {
  listSessions,
  createSession,
  renameSession,
  deleteSession,
  setSessionGroup,
  setSessionWorkspace,
  setSessionModel,
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
import { listAllMemories, listMemoriesByScope, addMemory, removeMemory, searchMemories, editMemory } from "../storage/memories";
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
  ModelInfo,
  PermissionMode,
  ProviderKind,
  VerifyResult,
} from "../../shared/types";

export function registerIpc(getWin: () => BrowserWindow | null): void {
  // Global IPC instrumentation: wrap every handler so each renderer request is
  // logged with its duration, and failures surface as ERROR lines. This is the
  // single highest-value debug surface for diagnosing "why did X not work".
  {
    const ipcAny = ipcMain as unknown as {
      handle: (
        channel: string,
        listener: (event: unknown, ...args: unknown[]) => unknown,
      ) => void;
    };
    const origHandle = ipcAny.handle.bind(ipcMain);
    ipcAny.handle = (channel, listener) => {
      origHandle(channel, async (event: unknown, ...args: unknown[]) => {
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
  }

  // Forward shell output from the terminal manager to the renderer.
  terminalManager.setSender((channel, ...args) =>
    getWin()?.webContents.send(channel, ...args),
  );

  // Let the agent manager push title updates outside the turn event stream.
  agentManager.setSender((channel, ...args) =>
    getWin()?.webContents.send(channel, ...args),
  );

  // ---- sessions ----
  ipcMain.handle("sessions:list", () => listSessions());
  ipcMain.handle(
    "sessions:create",
    (_e, title?: string, workspaceDir?: string, model?: string) =>
      createSession(title, workspaceDir, model),
  );
  ipcMain.handle("sessions:rename", (_e, id: string, title: string) =>
    renameSession(id, title),
  );
  ipcMain.handle("sessions:delete", (_e, id: string) => deleteSession(id));
  ipcMain.handle("sessions:setGroup", (_e, id: string, group: string) =>
    setSessionGroup(id, group),
  );
  ipcMain.handle("sessions:groups", () => listGroups());
  ipcMain.handle(
    "sessions:setWorkspace",
    (_e, id: string, workspaceDir: string) => setSessionWorkspace(id, workspaceDir),
  );
  ipcMain.handle("sessions:setModel", (_e, id: string, model: string) => {
    setSessionModel(id, model);
    agentManager.setSessionModel(id, model);
  });
  /** Recently used workspace folders (for the new-task folder picker). */
  ipcMain.handle("sessions:recentFolders", () => {
    const rows = getDb()
      .prepare(
        `SELECT workspace_dir, MAX(updated_at) AS latest
         FROM sessions WHERE workspace_dir IS NOT NULL AND workspace_dir != ''
         GROUP BY workspace_dir ORDER BY latest DESC LIMIT 8`,
      )
      .all() as Array<{ workspace_dir: string }>;
    return rows.map((r) => ({ path: r.workspace_dir, name: groupForWorkspace(r.workspace_dir) }));
  });
  ipcMain.handle("sessions:renameGroup", (_e, oldName: string, newName: string) =>
    renameGroup(oldName, newName),
  );
  ipcMain.handle("sessions:deleteGroup", (_e, name: string) => deleteGroup(name));
  ipcMain.handle("sessions:createGroup", (_e, name: string) => createGroup(name));

  // ---- skills ----
  ipcMain.handle("skills:list", () => listSkills());
  ipcMain.handle(
    "skills:create",
    (_e, input: { name: string; description?: string; body?: string }) =>
      createSkill(input),
  );
  ipcMain.handle(
    "skills:update",
    (_e, name: string, patch: Record<string, unknown>) =>
      updateSkill(name, patch as Parameters<typeof updateSkill>[1]),
  );
  ipcMain.handle("skills:delete", (_e, name: string) => deleteSkill(name));
  ipcMain.handle(
    "skills:rename",
    (_e, oldName: string, newName: string) => renameSkill(oldName, newName),
  );
  ipcMain.handle(
    "skills:import",
    async (_e, sourceDir: string, newName?: string) => importSkill(sourceDir, newName),
  );
  ipcMain.handle(
    "skills:export",
    async (_e, name: string, targetDir: string) => exportSkill(name, targetDir),
  );
  ipcMain.handle("skills:rebuild", () => agentManager.rebuildSkills());

  // ---- settings / keys ----
  ipcMain.handle("settings:get", () => loadSettings());
  ipcMain.handle("settings:save", (_e, s) => saveSettings(s));
  ipcMain.handle("settings:getKey", (_e, provider: ProviderKind) => getApiKey(provider));
  ipcMain.handle("settings:setKey", (_e, provider: ProviderKind, key: string) =>
    setApiKey(provider, key),
  );
  ipcMain.handle("settings:pickDirectory", async () => {
    const win = getWin();
    const res = await dialog.showOpenDialog(win!, {
      properties: ["openDirectory", "createDirectory"],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle("settings:rebuildAgent", () => agentManager.rebuild());
  ipcMain.handle("settings:setOnboarded", (_e, onboarded: boolean) => {
    const s = loadSettings();
    s.onboarded = onboarded;
    saveSettings(s);
  });
  ipcMain.handle("settings:applySystem", () => {
    const s = loadSettings();
    applyOpenAtLogin(s.openAtLogin);
    setKeepAwake(s.keepAwake);
  });
  ipcMain.handle("app:revealData", () => {
    shell.openPath(DEEPWORK_ROOT);
  });
  ipcMain.handle("app:dataPath", () => DEEPWORK_ROOT);
  ipcMain.handle("app:version", () => app.getVersion());

  // ---- model catalog / verification ----
  ipcMain.handle("models:catalog", (): ModelInfo[] => MODEL_CATALOG);
  ipcMain.handle("models:providers", () => PROVIDER_PRESETS);
  ipcMain.handle("models:verify", (_e, cfg): Promise<VerifyResult> =>
    verifyModelConfig(cfg),
  );

  // ---- chat ----
  ipcMain.handle("chat:history", async (_e, sessionId: string) => {
    const s = getSession(sessionId);
    // Derive the cwd/sandbox root and output drawer at runtime (works for old
    // sessions whose stored root_dir predates the .deepwork layout).
    const root = s ? sessionRootDir(s.id, s.workspaceDir) : undefined;
    const picked = hasPickedWorkspace(s?.workspaceDir);
    const outputDir = s && picked ? sessionArtifactsDir(s.id, s.workspaceDir!) : root;
    agentManager.setSessionRoot(sessionId, root, outputDir, picked);
    agentManager.setSessionModel(sessionId, s?.model);
    return agentManager.getHistory(sessionId);
  });

  ipcMain.handle(
    "chat:send",
    async (
      event,
      sessionId: string,
      text: string,
      attachments?: Attachment[],
      workspaceDir?: string,
      modelId?: string,
      mode?: PermissionMode,
    ) => {
      const sender = event.sender;
      const push = (e: DeepWorkEvent) => {
        if (!sender.isDestroyed()) sender.send("chat:event", sessionId, e);
      };
      try {
        if (modelId) setSessionModel(sessionId, modelId);
        // The agent operates in the session's cwd/sandbox root. For a picked
        // folder that is the folder itself; otherwise the isolated session dir.
        // Derive at runtime so old sessions pick up the new layout.
        const s = getSession(sessionId);
        const root = s ? sessionRootDir(s.id, s.workspaceDir) : undefined;
        const picked = hasPickedWorkspace(s?.workspaceDir);
        const outputDir = s && picked ? sessionArtifactsDir(s.id, s.workspaceDir!) : root;
        agentManager.setSessionRoot(sessionId, root, outputDir, picked);
        for await (const e of agentManager.runTurn(
          sessionId,
          text,
          attachments,
          root,
          modelId,
          mode,
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

  ipcMain.handle("chat:cancel", (_e, sessionId: string) => {
    agentManager.cancel(sessionId);
  });

  ipcMain.handle("chat:regenerate", async (event, sessionId: string) => {
    const sender = event.sender;
    const push = (e: DeepWorkEvent) => {
      if (!sender.isDestroyed()) sender.send("chat:event", sessionId, e);
    };
    try {
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
  ipcMain.handle(
    "approval:respond",
    (_e, id: string, decision: ApprovalDecision) => {
      approvals.respond(id, decision);
    },
  );

  // ---- memories ----
  ipcMain.handle("memories:list", () => listAllMemories());
  ipcMain.handle("memories:listByScope", (_e, scopeKey: string, type?: string) =>
    listMemoriesByScope(scopeKey, type as any),
  );
  ipcMain.handle("memories:search", (_e, scopeKey: string, query: string, topK?: number) =>
    searchMemories(scopeKey, query, { topK }),
  );
  ipcMain.handle("memories:add", (_e, content: string, type?: string, scopeKey?: string) =>
    addMemory(content, scopeKey ?? "", { type: type as any }),
  );
  ipcMain.handle("memories:edit", (_e, id: string, content: string) => editMemory(id, content));
  ipcMain.handle("memories:remove", (_e, id: string) => removeMemory(id));

  // ---- user memory (MD file) ----
  ipcMain.handle("userMemory:read", () => {
    const sections = readUserMemory();
    return Object.fromEntries(sections);
  });
  ipcMain.handle("userMemory:save", (_e, sections: Record<string, string>) => {
    const map = new Map<MemorySectionId, string>();
    for (const [k, v] of Object.entries(sections)) {
      if (MEMORY_SECTIONS.includes(k as MemorySectionId)) {
        map.set(k as MemorySectionId, v);
      }
    }
    saveUserMemory(map);
  });
  ipcMain.handle("userMemory:append", (_e, content: string, source?: string) =>
    appendToRecent(content, source),
  );
  ipcMain.handle("userMemory:raw", () => readRawMemory());
  ipcMain.handle("userMemory:saveRaw", (_e, markdown: string) => saveRawMemory(markdown));
  ipcMain.handle("userMemory:path", () => MEMORY_FILE);

  // ---- timeline memory (per-day markdown) ----
  ipcMain.handle("timeline:list", () => listTimelineDates());
  ipcMain.handle("timeline:read", (_e, date: string) => readTimelineDate(date));
  ipcMain.handle("timeline:path", (_e, date: string) => timelinePath(date));

  // ---- project memory (per-project markdown) ----
  ipcMain.handle("projectMemory:list", () => listProjects());
  ipcMain.handle("projectMemory:read", (_e, project: string) => readProjectMemory(project));
  ipcMain.handle("projectMemory:path", (_e, project: string) => projectMemoryPath(project));

  // ---- artifacts ----
  ipcMain.handle("artifacts:list", (_e, sessionId: string) =>
    agentManager.listArtifacts(sessionId),
  );
  ipcMain.handle("artifacts:reveal", (_e, absolutePath: string) => {
    if (isSafePath(absolutePath)) shell.showItemInFolder(absolutePath);
  });
  ipcMain.handle("artifacts:open", (_e, absolutePath: string) => {
    if (isSafePath(absolutePath)) shell.openPath(absolutePath);
  });

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

  ipcMain.handle("automations:list", () => listAutomations());
  ipcMain.handle("automations:listWithRuns", () => listAutomationsWithRuns());
  ipcMain.handle(
    "automations:create",
    (_e, a: Omit<Automation, "id" | "createdAt" | "updatedAt" | "enabled">) => createAutomation(a),
  );
  ipcMain.handle("automations:update", (_e, id: string, patch: Partial<Automation>) =>
    updateAutomation(id, patch),
  );
  ipcMain.handle("automations:delete", (_e, id: string) => deleteAutomation(id));
  ipcMain.handle("automations:runs", (_e, id: string) => listRuns(id));
  ipcMain.handle("automations:deleteRun", (_e, runId: string) => deleteRun(runId));
  ipcMain.handle("automations:deleteRuns", (_e, automationId: string) => deleteRuns(automationId));
  ipcMain.handle("automations:runNow", async (_e, id: string) => {
    const a = listAutomations().find((x) => x.id === id);
    if (a) await scheduler.runNow(a);
  });

  // ---- updates (electron-updater is optional; no-op if unavailable) ----
  ipcMain.handle("updates:check", async () => {
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
  ipcMain.handle("updates:install", async () => {
    try {
      const { autoUpdater } = await import("electron-updater");
      autoUpdater.quitAndInstall();
    } catch {
      // ignore
    }
  });

  // ---- terminal (interactive PTY accessible from the renderer) ----
  ipcMain.handle("terminal:spawn", (_e, id: string, cwd: string) =>
    terminalManager.spawn(id, cwd),
  );
  ipcMain.handle("terminal:input", (_e, id: string, data: string) =>
    terminalManager.input(id, data),
  );
  ipcMain.handle("terminal:resize", (_e, id: string, cols: number, rows: number) =>
    terminalManager.resize(id, cols, rows),
  );
  ipcMain.handle("terminal:kill", (_e, id: string) => terminalManager.kill(id));
}

/** Guard reveal/open to real files under the user's home directory. */
function isSafePath(p: string): boolean {
  if (!p || typeof p !== "string") return false;
  try {
    const resolved = path.resolve(p);
    if (!fs.existsSync(resolved)) return false;
    const home = app.getPath("home");
    return resolved.startsWith(home);
  } catch {
    return false;
  }
}
