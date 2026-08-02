import { ipcMain, type BrowserWindow, dialog, shell, app } from "electron";
import path from "node:path";
import fs from "node:fs";
import { agentManager } from "../agent/manager";
import { getDb } from "../storage/db";
import { applyOpenAtLogin, setKeepAwake } from "../system";
import { DEEPWORK_ROOT } from "../config/paths";
import { approvals } from "../security/approvals";
import { verifyModelConfig } from "../agent/model";
import { MODEL_CATALOG, PROVIDER_PRESETS } from "../../shared/providers";
import { scheduler } from "../automation/scheduler";

import {
  listSessions,
  createSession,
  renameSession,
  deleteSession,
  setSessionGroup,
  setSessionWorkspace,
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
} from "../skills/store";
import {
  loadSettings,
  saveSettings,
  getApiKey,
  setApiKey,
} from "../storage/settings";
import { listAllMemories, addMemory, removeMemory } from "../storage/memories";
import {
  listAutomations,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  listRuns,
} from "../storage/automations";
import type {
  ApprovalDecision,
  Attachment,
  Automation,
  DeepWorkEvent,
  ModelInfo,
  ProviderKind,
  VerifyResult,
} from "../../shared/types";

export function registerIpc(getWin: () => BrowserWindow | null): void {
  // ---- sessions ----
  ipcMain.handle("sessions:list", () => listSessions());
  ipcMain.handle(
    "sessions:create",
    (_e, title?: string, workspaceDir?: string) =>
      createSession(title, workspaceDir),
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
    (_e, name: string, patch: Partial<{ description: string; body: string; enabled: boolean }>) =>
      updateSkill(name, patch),
  );
  ipcMain.handle("skills:delete", (_e, name: string) => deleteSkill(name));
  ipcMain.handle("skills:rebuild", () => agentManager.rebuild());

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

  // ---- model catalog / verification ----
  ipcMain.handle("models:catalog", (): ModelInfo[] => MODEL_CATALOG);
  ipcMain.handle("models:providers", () => PROVIDER_PRESETS);
  ipcMain.handle("models:verify", (_e, cfg): Promise<VerifyResult> =>
    verifyModelConfig(cfg),
  );

  // ---- chat ----
  ipcMain.handle("chat:history", async (_e, sessionId: string) => {
    const s = getSession(sessionId);
    agentManager.setSessionWorkspace(sessionId, s?.workspaceDir);
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
    ) => {
      const sender = event.sender;
      const push = (e: DeepWorkEvent) => {
        if (!sender.isDestroyed()) sender.send("chat:event", sessionId, e);
      };
      try {
        for await (const e of agentManager.runTurn(
          sessionId,
          text,
          attachments,
          workspaceDir,
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
  ipcMain.handle("memories:add", (_e, content: string) => addMemory(content, ""));
  ipcMain.handle("memories:remove", (_e, id: string) => removeMemory(id));

  // ---- artifacts ----
  ipcMain.handle("artifacts:reveal", (_e, absolutePath: string) => {
    if (isSafePath(absolutePath)) shell.showItemInFolder(absolutePath);
  });
  ipcMain.handle("artifacts:open", (_e, absolutePath: string) => {
    if (isSafePath(absolutePath)) shell.openPath(absolutePath);
  });

  // ---- automations ----
  scheduler.init({
    runAutomationTurn: async (sessionId, instructions, onEvent) => {
      for await (const e of agentManager.runUnattendedTurn(sessionId, instructions)) {
        onEvent(e);
      }
    },
  });
  scheduler.start();
  scheduler.on("run:event", ({ sessionId, event }) => {
    getWin()?.webContents.send("chat:event", sessionId, event);
  });

  ipcMain.handle("automations:list", () => listAutomations());
  ipcMain.handle("automations:create", (_e, a: Omit<Automation, "id" | "createdAt" | "enabled">) =>
    createAutomation(a),
  );
  ipcMain.handle("automations:update", (_e, id: string, patch: Partial<Automation>) =>
    updateAutomation(id, patch),
  );
  ipcMain.handle("automations:delete", (_e, id: string) => deleteAutomation(id));
  ipcMain.handle("automations:runs", (_e, id: string) => listRuns(id));
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
