import { contextBridge, ipcRenderer } from "electron";
import type {
  ApprovalDecision,
  DeepWorkEvent,
  HistoryItem,
  ModelConfig,
  McpServerConfig,
  Session,
  Settings,
} from "../shared/types";

const api = {
  sessions: {
    list: (): Promise<Session[]> => ipcRenderer.invoke("sessions:list"),
    create: (title?: string): Promise<Session> =>
      ipcRenderer.invoke("sessions:create", title),
    rename: (id: string, title: string): Promise<void> =>
      ipcRenderer.invoke("sessions:rename", id, title),
    delete: (id: string): Promise<void> => ipcRenderer.invoke("sessions:delete", id),
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke("settings:get"),
    save: (s: Settings): Promise<void> => ipcRenderer.invoke("settings:save", s),
    getKey: (provider: "anthropic" | "openai"): Promise<string> =>
      ipcRenderer.invoke("settings:getKey", provider),
    setKey: (provider: "anthropic" | "openai", key: string): Promise<void> =>
      ipcRenderer.invoke("settings:setKey", provider, key),
    pickDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke("settings:pickDirectory"),
    rebuildAgent: (): Promise<void> => ipcRenderer.invoke("settings:rebuildAgent"),
  },
  chat: {
    history: (sessionId: string): Promise<{ timeline: HistoryItem[] }> =>
      ipcRenderer.invoke("chat:history", sessionId),
    send: (sessionId: string, text: string): Promise<void> =>
      ipcRenderer.invoke("chat:send", sessionId, text),
    regenerate: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke("chat:regenerate", sessionId),
    onEvent: (sessionId: string, cb: (e: DeepWorkEvent) => void): (() => void) => {
      const listener = (_e: unknown, sid: string, event: DeepWorkEvent) => {
        if (sid === sessionId) cb(event);
      };
      ipcRenderer.on("chat:event", listener);
      return () => ipcRenderer.removeListener("chat:event", listener);
    },
  },
  approval: {
    respond: (id: string, decision: ApprovalDecision): Promise<void> =>
      ipcRenderer.invoke("approval:respond", id, decision),
  },
};

contextBridge.exposeInMainWorld("deepwork", api);
export type DeepWorkApi = typeof api;
