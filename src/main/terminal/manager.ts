import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as ptySpawn, type IPty } from "node-pty";

export type TerminalDataSender = (channel: string, ...args: unknown[]) => void;

/**
 * Owns the set of interactive PTYs backing the in-app terminal panel.
 *
 * The renderer drives each terminal by id through IPC; the manager forwards
 * shell output to the renderer over `terminal:data` and writes user keystrokes
 * back into the PTY. This is intentionally minimal — a single, user-controlled
 * interactive shell per terminal id, no multiplexing or reconnect logic.
 */
class TerminalManager {
  private terms = new Map<string, IPty>();
  private send: TerminalDataSender = () => {};

  /** Wire the manager to the active window's webContents sender. */
  setSender(fn: TerminalDataSender): void {
    this.send = fn;
  }

  spawn(id: string, cwd: string): void {
    if (this.terms.has(id)) this.kill(id);
    const shell =
      process.env.SHELL ||
      (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
    const env = { ...(process.env as Record<string, string>) };
    // Point zsh at a fresh completion dump per terminal so it never loads the
    // user's stale ~/.zcompdump. A stale dump can reference completion files
    // removed by Homebrew (e.g. _brew_services) and emit "no such file" errors
    // on the first line. A clean rebuild scans the current fpath and skips them.
    env.ZSH_COMPDUMP = path.join(os.tmpdir(), `deepwork-zcompdump-${id}`);
    const dir =
      cwd && fs.existsSync(cwd) ? cwd : process.env.HOME || process.cwd();
    const term = ptySpawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: dir,
      env,
    });
    term.onData((data) => this.send("terminal:data", id, data));
    this.terms.set(id, term);
  }

  input(id: string, data: string): void {
    this.terms.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const term = this.terms.get(id);
    if (!term) return;
    try {
      term.resize(cols, rows);
    } catch {
      // A pty can throw if the child already exited; ignore.
    }
  }

  kill(id: string): void {
    const term = this.terms.get(id);
    if (!term) return;
    try {
      term.kill();
    } catch {
      // already gone
    }
    this.terms.delete(id);
  }

  killAll(): void {
    for (const id of [...this.terms.keys()]) this.kill(id);
  }
}

export const terminalManager = new TerminalManager();
