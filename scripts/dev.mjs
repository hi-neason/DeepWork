#!/usr/bin/env node
// Dev launcher. Runs `electron-vite dev` but points $ELECTRON_EXEC_PATH at
// scripts/electron-filter.mjs, which suppresses the noisy macOS IMK warning
// ("error messaging the mach port for IMKCFRunLoopWakeUpReliable") from
// Electron's stderr. Pass through any extra CLI args.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prepareElectronDevExecutable } from "./prepare-electron-dev.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-vite.cmd" : "electron-vite",
);
const filter = path.join(root, "scripts", "electron-filter.mjs");
const realElectron = await prepareElectronDevExecutable(root);

const child = spawn(bin, ["dev", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    ELECTRON_EXEC_PATH: filter,
    ELECTRON_REAL_EXEC_PATH: realElectron,
  },
});

child.on("error", (err) => {
  console.error("[dev] failed to start electron-vite:", err);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
