import { contextBridge, ipcRenderer } from "electron";
import type {
  ApprovalDecision,
  ArtifactFile,
  Attachment,
  Automation,
  DeepWorkEvent,
  HistoryItem,
  MemoryItem,
  ModelConfig,
  ModelInfo,
  McpServerConfig,
  ProviderKind,
  Session,
  Settings,
  UpdateStatus,
  VerifyResult,
} from "../shared/types";
import type { ProviderPreset } from "../shared/providers";

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
    getKey: (provider: ProviderKind): Promise<string> =>
      ipcRenderer.invoke("settings:getKey", provider),
    setKey: (provider: ProviderKind, key: string): Promise<void> =>
      ipcRenderer.invoke("settings:setKey", provider, key),
    pickDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke("settings:pickDirectory"),
    rebuildAgent: (): Promise<void> => ipcRenderer.invoke("settings:rebuildAgent"),
    setOnboarded: (onboarded: boolean): Promise<void> =>
      ipcRenderer.invoke("settings:setOnboarded", onboarded),
  },
  models: {
    catalog: (): Promise<ModelInfo[]> => ipcRenderer.invoke("models:catalog"),
    providers: (): Promise<Record<ProviderKind, ProviderPreset>> =>
      ipcRenderer.invoke("models:providers"),
    verify: (cfg: ModelConfig): Promise<VerifyResult> =>
      ipcRenderer.invoke("models:verify", cfg),
  },
  chat: {
    history: (sessionId: string): Promise<{ timeline: HistoryItem[] }> =>
      ipcRenderer.invoke("chat:history", sessionId),
    send: (
      sessionId: string,
      text: string,
      attachments?: Attachment[],
    ): Promise<void> =>
      ipcRenderer.invoke("chat:send", sessionId, text, attachments),
    cancel: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke("chat:cancel", sessionId),
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
  memories: {
    list: (): Promise<MemoryItem[]> => ipcRenderer.invoke("memories:list"),
    add: (content: string): Promise<MemoryItem> =>
      ipcRenderer.invoke("memories:add", content),
    remove: (id: string): Promise<void> => ipcRenderer.invoke("memories:remove", id),
  },
  artifacts: {
    reveal: (absolutePath: string): Promise<void> =>
      ipcRenderer.invoke("artifacts:reveal", absolutePath),
    open: (absolutePath: string): Promise<void> =>
      ipcRenderer.invoke("artifacts:open", absolutePath),
  },
  automations: {
    list: (): Promise<Automation[]> => ipcRenderer.invoke("automations:list"),
    create: (a: Omit<Automation, "id" | "createdAt" | "enabled">): Promise<Automation> =>
      ipcRenderer.invoke("automations:create", a),
    update: (id: string, patch: Partial<Automation>): Promise<void> =>
      ipcRenderer.invoke("automations:update", id, patch),
    delete: (id: string): Promise<void> => ipcRenderer.invoke("automations:delete", id),
    runs: (id: string) => ipcRenderer.invoke("automations:runs", id),
    runNow: (id: string): Promise<void> => ipcRenderer.invoke("automations:runNow", id),
  },
  updates: {
    check: (): Promise<void> => ipcRenderer.invoke("updates:check"),
    install: (): Promise<void> => ipcRenderer.invoke("updates:install"),
    onStatus: (cb: (status: UpdateStatus) => void): (() => void) => {
      const listener = (_e: unknown, status: UpdateStatus) => cb(status);
      ipcRenderer.on("update:status", listener);
      return () => ipcRenderer.removeListener("update:status", listener);
    },
  },
};

contextBridge.exposeInMainWorld("deepwork", api);
export type DeepWorkApi = typeof api;
