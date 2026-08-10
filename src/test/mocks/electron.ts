/**
 * 最小化 electron 桩，供主进程模块的单元测试用 `vi.mock("electron", ...)`
 * 替换真实依赖。Phase 2（需 mock Electron 的主进程模块测试）再按需补全。
 *
 * 用法（测试文件内）：
 *   import { vi } from "vitest";
 *   vi.mock("electron", () => import("../../test/mocks/electron"));
 *
 * 注意：本桩只提供"可被调用/可被 spies 替换"的空实现，不模拟真实行为。
 * 测试里通常紧接着用 vi.spyOn 或重新 assign 来定制返回值。
 */

type Noop = (...args: any[]) => any;

function noop(): Noop {
  return () => undefined;
}

export const app = {
  getPath: (name: string) => `/tmp/deepwork-test/${name}`,
  getAppPath: () => "/tmp/deepwork-test",
  getName: () => "deepwork-test",
  getVersion: () => "0.0.0-test",
  isReady: () => true,
  whenReady: () => Promise.resolve(),
  on: noop(),
  off: noop(),
  quit: noop(),
  exit: noop(),
  setLoginItemSettings: noop(),
};

export const BrowserWindow = class {
  constructor(_opts?: any) {}
  loadURL = noop();
  loadFile = noop();
  show = noop();
  hide = noop();
  close = noop();
  on = noop();
  webContents = {
    send: noop(),
    on: noop(),
    openDevTools: noop(),
    session: { setSpellCheckerLanguages: noop() },
  };
  static getAllWindows = () => [] as any[];
};

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s, "utf8"),
  decryptString: (b: Buffer) => b.toString("utf8"),
};

const __ipcHandlers = new Map<string, (...args: any[]) => any>();

/** 测试用：取出 registerIpc 注册的所有 handler。 */
export function __test_getHandlers(): Map<string, (...args: any[]) => any> {
  return __ipcHandlers;
}

export const ipcMain = {
  handle: (channel: string, listener: (...args: any[]) => any) => {
    __ipcHandlers.set(channel, listener);
    return ipcMain;
  },
  on: noop(),
  removeHandler: noop(),
  removeAllListeners: noop(),
};

export const nativeImage = {
  createFromPath: () => ({ toPNG: () => Buffer.alloc(0), toDataURL: () => "" }),
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: "" }),
  showMessageBox: async () => ({ response: 0 }),
};

export const shell = {
  openExternal: noop(),
  openPath: noop(),
  showItemInFolder: noop(),
};

export const clipboard = {
  writeText: noop(),
  readText: () => "",
};

export const Menu = { buildFromTemplate: () => ({}), setApplicationMenu: noop(), popup: noop() };
export const Tray = class {
  constructor(_icon?: any) {}
  setToolTip = noop();
  setContextMenu = noop();
};
export const Notification = class {
  constructor(_opts?: any) {}
  show = noop();
};
export const session = { defaultSession: { setSpellCheckerLanguages: noop() } };
export const webContents = { getAllWebContents: () => [] as any[] };

export default {
  app,
  BrowserWindow,
  safeStorage,
  ipcMain,
  nativeImage,
  dialog,
  shell,
  clipboard,
  Menu,
  Tray,
  Notification,
  session,
  webContents,
};
