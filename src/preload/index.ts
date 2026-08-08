import { contextBridge, ipcRenderer } from "electron";
import type {
  ApprovalDecision,
  ArtifactFile,
  Attachment,
  Automation,
  DeepWorkEvent,
  HistoryItem,
  MemoryItem,
  MemoryType,
  ModelConfig,
  ModelInfo,
  McpServerConfig,
  ProviderKind,
  Session,
  Settings,
  Skill,
  TodoItem,
  UpdateStatus,
  VerifyResult,
} from "../shared/types";
import type { ProviderPreset } from "../shared/providers";

const api = {
  sessions: {
    list: (): Promise<Session[]> => ipcRenderer.invoke("sessions:list"),
    create: (
      title?: string,
      workspaceDir?: string,
      model?: string,
    ): Promise<Session> =>
      ipcRenderer.invoke("sessions:create", title, workspaceDir, model),
    rename: (id: string, title: string): Promise<void> =>
      ipcRenderer.invoke("sessions:rename", id, title),
    delete: (id: string): Promise<void> => ipcRenderer.invoke("sessions:delete", id),
    setGroup: (id: string, group: string): Promise<void> =>
      ipcRenderer.invoke("sessions:setGroup", id, group),
    setWorkspace: (id: string, workspaceDir: string): Promise<void> =>
      ipcRenderer.invoke("sessions:setWorkspace", id, workspaceDir),
    setModel: (id: string, model: string): Promise<void> =>
      ipcRenderer.invoke("sessions:setModel", id, model),
    groups: (): Promise<string[]> => ipcRenderer.invoke("sessions:groups"),
    recentFolders: (): Promise<{ path: string; name: string }[]> =>
      ipcRenderer.invoke("sessions:recentFolders"),
    renameGroup: (oldName: string, newName: string): Promise<void> =>
      ipcRenderer.invoke("sessions:renameGroup", oldName, newName),
    deleteGroup: (name: string): Promise<void> =>
      ipcRenderer.invoke("sessions:deleteGroup", name),
    createGroup: (name: string): Promise<void> =>
      ipcRenderer.invoke("sessions:createGroup", name),
  },
  skills: {
    list: (): Promise<Skill[]> => ipcRenderer.invoke("skills:list"),
    create: (input: {
      name: string;
      description?: string;
      body?: string;
    }): Promise<Skill> => ipcRenderer.invoke("skills:create", input),
    update: (
      name: string,
      patch: Partial<Pick<Skill, "description" | "body" | "enabled" | "license" | "compatibility" | "metadata" | "allowedTools">>,
    ): Promise<Skill | null> =>
      ipcRenderer.invoke("skills:update", name, patch),
    delete: (name: string): Promise<void> =>
      ipcRenderer.invoke("skills:delete", name),
    rename: (oldName: string, newName: string): Promise<Skill | null> =>
      ipcRenderer.invoke("skills:rename", oldName, newName),
    import: (sourceDir: string, newName?: string): Promise<Skill> =>
      ipcRenderer.invoke("skills:import", sourceDir, newName),
    export: (name: string, targetDir: string): Promise<string> =>
      ipcRenderer.invoke("skills:export", name, targetDir),
    rebuild: (): Promise<void> => ipcRenderer.invoke("skills:rebuild"),
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
    applySystem: (): Promise<void> => ipcRenderer.invoke("settings:applySystem"),
  },
  app: {
    dataPath: (): Promise<string> => ipcRenderer.invoke("app:dataPath"),
    revealData: (): Promise<void> => ipcRenderer.invoke("app:revealData"),
  },
  models: {
    catalog: (): Promise<ModelInfo[]> => ipcRenderer.invoke("models:catalog"),
    providers: (): Promise<Record<ProviderKind, ProviderPreset>> =>
      ipcRenderer.invoke("models:providers"),
    verify: (cfg: ModelConfig): Promise<VerifyResult> =>
      ipcRenderer.invoke("models:verify", cfg),
  },
  chat: {
    history: (
      sessionId: string,
    ): Promise<{ timeline: HistoryItem[]; todos: TodoItem[] }> =>
      ipcRenderer.invoke("chat:history", sessionId),
    send: (
      sessionId: string,
      text: string,
      attachments?: Attachment[],
      workspaceDir?: string,
      modelId?: string,
    ): Promise<void> =>
      ipcRenderer.invoke(
        "chat:send",
        sessionId,
        text,
        attachments,
        workspaceDir,
        modelId,
      ),
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
    // Subscribe to every session's events (the callback receives the sessionId
    // too). Used by the renderer to maintain a single, race-free subscription
    // instead of tearing down/recreating one whenever the active session changes.
    onAnyEvent: (
      cb: (sessionId: string, e: DeepWorkEvent) => void,
    ): (() => void) => {
      const listener = (_e: unknown, sid: string, event: DeepWorkEvent) => {
        cb(sid, event);
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
    listByScope: (scopeKey: string, type?: MemoryType): Promise<MemoryItem[]> =>
      ipcRenderer.invoke("memories:listByScope", scopeKey, type),
    search: (scopeKey: string, query: string, topK?: number): Promise<MemoryItem[]> =>
      ipcRenderer.invoke("memories:search", scopeKey, query, topK),
    add: (content: string, type?: MemoryType, scopeKey?: string): Promise<MemoryItem> =>
      ipcRenderer.invoke("memories:add", content, type, scopeKey),
    edit: (id: string, content: string): Promise<void> =>
      ipcRenderer.invoke("memories:edit", id, content),
    remove: (id: string): Promise<void> => ipcRenderer.invoke("memories:remove", id),
  },
  userMemory: {
    read: (): Promise<Record<string, string>> => ipcRenderer.invoke("userMemory:read"),
    save: (sections: Record<string, string>): Promise<void> =>
      ipcRenderer.invoke("userMemory:save", sections),
    append: (content: string, source?: string): Promise<void> =>
      ipcRenderer.invoke("userMemory:append", content, source),
    raw: (): Promise<string> => ipcRenderer.invoke("userMemory:raw"),
    saveRaw: (markdown: string): Promise<void> =>
      ipcRenderer.invoke("userMemory:saveRaw", markdown),
    path: (): Promise<string> => ipcRenderer.invoke("userMemory:path"),
  },
  artifacts: {
    list: (sessionId: string): Promise<ArtifactFile[]> =>
      ipcRenderer.invoke("artifacts:list", sessionId),
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
  terminal: {
    spawn: (id: string, cwd: string): Promise<void> =>
      ipcRenderer.invoke("terminal:spawn", id, cwd),
    input: (id: string, data: string): Promise<void> =>
      ipcRenderer.invoke("terminal:input", id, data),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke("terminal:resize", id, cols, rows),
    kill: (id: string): Promise<void> => ipcRenderer.invoke("terminal:kill", id),
    onData: (cb: (id: string, data: string) => void): (() => void) => {
      const listener = (_e: unknown, id: string, data: string) => cb(id, data);
      ipcRenderer.on("terminal:data", listener);
      return () => ipcRenderer.removeListener("terminal:data", listener);
    },
  },
};

contextBridge.exposeInMainWorld("deepwork", api);
export type DeepWorkApi = typeof api;
