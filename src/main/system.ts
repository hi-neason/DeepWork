import { app, powerSaveBlocker } from "electron";

let blockerId: number | null = null;

/** Apply the "open at login" OS setting. */
export function applyOpenAtLogin(enabled: boolean): void {
  if (process.platform === "linux") return; // setLoginItemSettings unsupported on most Linux
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
  });
}

/** Keep the machine awake while the app is running (for long turns/automations). */
export function setKeepAwake(enabled: boolean): void {
  if (enabled && blockerId === null) {
    blockerId = powerSaveBlocker.start("prevent-display-sleep");
  } else if (!enabled && blockerId !== null) {
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}
