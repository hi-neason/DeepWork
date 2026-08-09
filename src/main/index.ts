import { app, shell, BrowserWindow, session, Tray, Menu, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerIpc } from "./ipc/register";
import { terminalManager } from "./terminal/manager";
import { getDb, closeDb } from "./storage/db";
import { agentManager } from "./agent/manager";
import { loadClaudeCodeEnv } from "./config/ccEnv";
import { loadSettings } from "./storage/settings";
import { ensureDirs } from "./config/paths";
import { applyOpenAtLogin, setKeepAwake } from "./system";
import { TRAY_ICON_16, TRAY_ICON_36 } from "./trayIcon";
import i18n, { i18nReady } from "./i18n";
import { logger, configureLogger } from "./log/logger";
import { installHttpLogging } from "./log/http";

// Reuse Claude Code's ANTHROPIC_* env (endpoint/auth token/model) at runtime.
// This must run before the agent/model layer is first used. No secrets are
// hardcoded or stored by DeepWork.
loadClaudeCodeEnv();

// Capture fatal errors as early as possible so crashes are never silent.
process.on("uncaughtException", (err) => {
  logger.error("app", "uncaughtException", { message: err.message, stack: err.stack });
});
process.on("unhandledRejection", (reason) => {
  const e = reason as Error;
  logger.error("app", "unhandledRejection", {
    message: e?.message ?? String(reason),
    stack: e?.stack,
  });
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// Single instance: a second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

/**
 * Set a Content-Security-Policy header. In dev the Vite dev server needs
 * http: scripts and ws: for HMR; in production everything is self-contained.
 */
function applyCsp(): void {
  const isDev = !!process.env.ELECTRON_RENDERER_URL;
  const csp = isDev
    ? [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:*",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self' ws://localhost:* http://localhost:* data:",
        "worker-src 'self' blob:",
      ].join("; ")
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self' data:",
      ].join("; ");

  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] } });
  });
}

function createTray(): void {
  // A monochrome template glyph (macOS tints it for light/dark menu bars).
  try {
    const img = nativeImage.createFromDataURL(TRAY_ICON_16);
    img.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_36 });
    img.setTemplateImage(true);
    tray = new Tray(img);
    tray.setToolTip("DeepWork");
    const menu = Menu.buildFromTemplate([
      { label: i18n.t("tray.open"), click: () => win?.show() },
      { type: "separator" },
      {
        label: i18n.t("tray.quit"),
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
    tray.on("click", () => win?.show());
  } catch {
    tray = null;
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 560,
    title: "DeepWork",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  applyCsp();

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  // Close-to-tray: hide instead of quitting unless the user quits from the
  // tray menu or the setting is disabled.
  win.on("close", (e) => {
    const settings = loadSettings();
    if (!isQuitting && settings.trayEnabled && tray) {
      e.preventDefault();
      win?.hide();
    }
  });

  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(async () => {
  ensureDirs(); // create ~/DeepWork/{app,skills,workspace}
  getDb(); // initialize DB / migrations
  // Sync the runtime logger config from saved settings.
  const bootSettings = loadSettings();
  configureLogger({
    enabled: bootSettings.logEnabled,
    workspaceDir: bootSettings.model.workspaceDir,
  });
  // Instrument the main process fetch so every model/provider HTTP call is
  // mirrored into the structured log (network failures, latency, status).
  installHttpLogging();
  logger.info("app", "ready", { version: app.getVersion() });
  await i18nReady;
  // Apply the user's saved interface language to the main process (tray menu,
  // error messages). The renderer keeps its own instance and syncs separately.
  if (bootSettings.language) void i18n.changeLanguage(bootSettings.language);
  registerIpc(() => win);
  createWindow();
  createTray();

  // Apply OS-level preferences.
  const s = loadSettings();
  applyOpenAtLogin(s.openAtLogin);
  setKeepAwake(s.keepAwake);

  // Initialize the agent in the background so first message is snappy.
  // A missing API key is expected on first run; the user configures it via onboarding.
  void agentManager.ensureAgent().catch((err) => {
    console.info("Agent not initialized yet (configure API key in Settings):", err.message);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else win?.show();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  terminalManager.killAll();
  // Flush WAL and release the DB handle cleanly (L-3).
  closeDb();
});

app.on("window-all-closed", () => {
  // On macOS keep running in the tray if enabled; otherwise quit on non-mac.
  const settings = loadSettings();
  if (process.platform !== "darwin" && !settings.trayEnabled) app.quit();
});
