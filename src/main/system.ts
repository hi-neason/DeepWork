import { app, powerSaveBlocker } from "electron";
import { logger } from "./log/logger";

let blockerId: number | null = null;
let loginItemEnabled = false;

/**
 * Apply the "open at login" OS setting. On macOS this requires the app to be
 * signed and launched from a .app bundle; when run unpackaged (`electron .`)
 * the OS rejects it with "Operation not permitted", so we swallow the error
 * and only apply when the value actually changes.
 */
export function applyOpenAtLogin(enabled: boolean): void {
  if (enabled === loginItemEnabled) return;
  loginItemEnabled = enabled;
  if (process.platform === "linux") return; // unsupported on most Linux
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
    });
  } catch (err) {
    // Non-fatal: usually an unsigned/dev build. Log once instead of throwing.
    logger.info("system", "openAtLogin not applied (dev/unsigned build expected)", {
      enabled,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Keep the machine awake while the app is running (for long turns/automations). */
export function setKeepAwake(enabled: boolean): void {
  if (enabled && blockerId === null) {
    blockerId = powerSaveBlocker.start("prevent-display-sleep");
    logger.info("system", "keepAwake enabled", { blockerId });
  } else if (!enabled && blockerId !== null) {
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
    logger.info("system", "keepAwake disabled", { blockerId });
    blockerId = null;
  }
}
