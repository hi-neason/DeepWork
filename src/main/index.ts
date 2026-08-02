import { app, shell, BrowserWindow, session } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerIpc } from "./ipc/register";
import { getDb } from "./storage/db";
import { agentManager } from "./agent/manager";
import { loadClaudeCodeEnv } from "./config/ccEnv";

// Reuse Claude Code's ANTHROPIC_* env (endpoint/auth token/model) at runtime.
// This must run before the agent/model layer is first used. No secrets are
// hardcoded or stored by DeepWork.
loadClaudeCodeEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;

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

  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(() => {
  getDb(); // initialize DB / migrations
  registerIpc(() => win);
  createWindow();

  // Initialize the agent in the background so first message is snappy.
  // A missing API key is expected on first run; the user configures it in Settings.
  void agentManager.ensureAgent().catch((err) => {
    console.info("Agent not initialized yet (configure API key in Settings):", err.message);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
