#!/usr/bin/env node
// Drop-in replacement for the Electron executable. electron-vite spawns the
// path in $ELECTRON_EXEC_PATH with `stdio: 'inherit'`, so by pointing it here
// we intercept Electron's own stderr and filter out the noisy, harmless macOS
// Input Method Kit message:
//   "error messaging the mach port for IMKCFRunLoopWakeUpReliable"
//
// stdout/stdin are inherited untouched; only stderr is piped through a filter.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);

// Resolve the real Electron binary. `require("electron")` returns its path.
const realElectron = process.env.ELECTRON_REAL_EXEC_PATH || require("electron");

// Allow extra patterns via env (comma-separated regex source strings).
const extra = (process.env.ELECTRON_STDERR_FILTER || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => new RegExp(s));

const DENYLIST = [
  /IMKCFRunLoopWakeUpReliable/,
  /error messaging the mach port for IMK/,
  ...extra,
];
const isNoise = (line) => DENYLIST.some((re) => re.test(line));

const child = spawn(realElectron, process.argv.slice(2), {
  stdio: ["inherit", "inherit", "pipe"],
  env: process.env,
});

let buf = "";
child.stderr.on("data", (chunk) => {
  buf += chunk.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!isNoise(line)) process.stderr.write(line + "\n");
  }
});
child.stderr.on("end", () => {
  if (buf && !isNoise(buf)) process.stderr.write(buf);
});

child.on("error", (err) => {
  console.error("[electron-filter] failed to launch Electron:", err);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

// Keep the referenced path import meaningful for bundlers/tooling.
void path;
void fileURLToPath;
