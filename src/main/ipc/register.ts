import { ipcMain, type BrowserWindow, dialog } from "electron";
import { agentManager } from "../agent/manager";
import { approvals } from "../security/approvals";

import {
  listSessions,
  createSession,
  renameSession,
  deleteSession,
} from "../storage/sessions";
import {
  loadSettings,
  saveSettings,
  getApiKey,
  setApiKey,
} from "../storage/settings";
import type { ApprovalDecision, DeepWorkEvent } from "../../shared/types";

export function registerIpc(getWin: () => BrowserWindow | null): void {
  // ---- sessions ----
  ipcMain.handle("sessions:list", () => listSessions());
  ipcMain.handle("sessions:create", (_e, title?: string) => createSession(title));
  ipcMain.handle("sessions:rename", (_e, id: string, title: string) => renameSession(id, title));
  ipcMain.handle("sessions:delete", (_e, id: string) => deleteSession(id));

  // ---- settings / keys ----
  ipcMain.handle("settings:get", () => loadSettings());
  ipcMain.handle("settings:save", (_e, s) => saveSettings(s));
  ipcMain.handle("settings:getKey", (_e, provider: "anthropic" | "openai") =>
    getApiKey(provider),
  );
  ipcMain.handle("settings:setKey", (_e, provider: "anthropic" | "openai", key: string) =>
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

  // ---- chat ----
  ipcMain.handle("chat:history", (_e, sessionId: string) =>
    agentManager.getHistory(sessionId),
  );

  ipcMain.handle("chat:send", async (event, sessionId: string, text: string) => {
    const sender = event.sender;
    const push = (e: DeepWorkEvent) => {
      if (!sender.isDestroyed()) sender.send("chat:event", sessionId, e);
    };
    try {
      for await (const e of agentManager.runTurn(sessionId, text)) {
        push(e);
      }
    } catch (err) {
      push({
        type: "turn_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
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
}
