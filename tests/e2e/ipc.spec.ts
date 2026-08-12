import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("renderer reaches validated session IPC handlers", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deepwork-e2e-"));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

  try {
    app = await electron.launch({
      // A separate profile prevents the production app's single-instance lock
      // from accepting this test process as a second launch.
      args: [".", `--user-data-dir=${path.join(home, "electron")}`],
      env: { ...process.env, HOME: home },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const session = await page.evaluate(async () =>
      window.deepwork.sessions.create("E2E session"),
    );
    const listed = await page.evaluate(async () => window.deepwork.sessions.list());

    expect(session.title).toBe("E2E session");
    expect(listed.map((item) => item.id)).toContain(session.id);

    await page.evaluate(async (id) => window.deepwork.sessions.delete(id), session.id);
    const afterDelete = await page.evaluate(async () => window.deepwork.sessions.list());
    expect(afterDelete.map((item) => item.id)).not.toContain(session.id);
  } finally {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("settings survive an Electron restart", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deepwork-e2e-"));
  const options = { args: [".", `--user-data-dir=${path.join(home, "electron")}`], env: { ...process.env, HOME: home } };
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch(options);
    let page = await app.firstWindow();
    const saved = await page.evaluate(async () => {
      const settings = await window.deepwork.settings.get();
      const next = { ...settings, language: "en-US" as const, fontScale: 1.1 };
      await window.deepwork.settings.save(next);
      return next;
    });
    await app.close();
    app = await electron.launch(options);
    page = await app.firstWindow();
    const restored = await page.evaluate(async () => window.deepwork.settings.get());
    expect(restored.language).toBe(saved.language);
    expect(restored.fontScale).toBe(saved.fontScale);
  } finally {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("session metadata mutations survive through preload and SQLite", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deepwork-e2e-"));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", `--user-data-dir=${path.join(home, "electron")}`], env: { ...process.env, HOME: home } });
    const page = await app.firstWindow();
    const result = await page.evaluate(async () => {
      const session = await window.deepwork.sessions.create("Before", undefined, undefined, "manual");
      await window.deepwork.sessions.rename(session.id, "After");
      await window.deepwork.sessions.createGroup("Project A");
      await window.deepwork.sessions.setGroup(session.id, "Project A");
      await window.deepwork.sessions.setModel(session.id, "openai:test-model");
      await window.deepwork.sessions.setPermissionMode(session.id, "plan");
      return window.deepwork.sessions.get(session.id);
    });
    expect(result).toMatchObject({ title: "After", group: "Project A", model: "openai:test-model", permissionMode: "plan" });
  } finally {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("automation CRUD and run history APIs cross the real process boundary", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deepwork-e2e-"));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", `--user-data-dir=${path.join(home, "electron")}`], env: { ...process.env, HOME: home } });
    const page = await app.firstWindow();
    const result = await page.evaluate(async () => {
      const created = await window.deepwork.automations.create({
        title: "E2E automation", instructions: "Do not run", scheduleType: "daily",
        scheduleConfig: { time: "23:59", timezone: "UTC" }, permissionMode: "plan",
      });
      await window.deepwork.automations.update(created.id, { enabled: false, title: "Updated automation" });
      const listed = await window.deepwork.automations.list();
      const runs = await window.deepwork.automations.runs(created.id);
      await window.deepwork.automations.delete(created.id);
      return { updated: listed.find((item) => item.id === created.id), runs, remaining: await window.deepwork.automations.list() };
    });
    expect(result.updated).toMatchObject({ title: "Updated automation", enabled: false, permissionMode: "plan" });
    expect(result.runs).toEqual([]);
    expect(result.remaining).toEqual([]);
  } finally {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("terminal PTY spawns, receives input, emits output, and shuts down", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deepwork-e2e-"));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", `--user-data-dir=${path.join(home, "electron")}`], env: { ...process.env, HOME: home } });
    const page = await app.firstWindow();
    const output = await page.evaluate(async () => {
      const session = await window.deepwork.sessions.create("Terminal E2E");
      const terminalId = `e2e-${Date.now()}`;
      return new Promise<string>(async (resolve, reject) => {
        let text = "";
        const timer = setTimeout(() => reject(new Error(`PTY timeout: ${text}`)), 10_000);
        const off = window.deepwork.terminal.onData((id, chunk) => {
          if (id !== terminalId) return;
          text += chunk;
          if (text.includes("DEEPWORK_E2E_PTY")) {
            clearTimeout(timer);
            off();
            void window.deepwork.terminal.kill(terminalId).then(() => resolve(text));
          }
        });
        await window.deepwork.terminal.spawn(terminalId, session.id);
        await window.deepwork.terminal.input(terminalId, "printf 'DEEPWORK_E2E_PTY\\n'\n");
      });
    });
    expect(output).toContain("DEEPWORK_E2E_PTY");
  } finally {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("invalid renderer payloads are rejected by real IPC validation", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deepwork-e2e-"));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", `--user-data-dir=${path.join(home, "electron")}`], env: { ...process.env, HOME: home } });
    const page = await app.firstWindow();
    const messages = await page.evaluate(async () => {
      const errors: string[] = [];
      try { await window.deepwork.sessions.create("bad", "../escape"); } catch (error) { errors.push(String(error)); }
      try { await window.deepwork.automations.update("a1", { createdAt: 1 }); } catch (error) { errors.push(String(error)); }
      try { await window.deepwork.terminal.resize("term", 0, 0); } catch (error) { errors.push(String(error)); }
      return errors;
    });
    expect(messages).toHaveLength(3);
  } finally {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("memory lifecycle persists through preload, IPC, and SQLite", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deepwork-e2e-"));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", `--user-data-dir=${path.join(home, "electron")}`], env: { ...process.env, HOME: home } });
    const page = await app.firstWindow();
    const result = await page.evaluate(async () => {
      const created = await window.deepwork.memories.add("Initial memory", "fact", "");
      await window.deepwork.memories.edit(created.id, "Edited memory");
      await window.deepwork.memories.invalidate(created.id);
      const invalid = (await window.deepwork.memories.list(true)).find((item) => item.id === created.id);
      await window.deepwork.memories.restore(created.id);
      const restored = (await window.deepwork.memories.list()).find((item) => item.id === created.id);
      await window.deepwork.memories.remove(created.id);
      const removed = !(await window.deepwork.memories.list(true)).some((item) => item.id === created.id);
      return { invalid, restored, removed };
    });
    expect(result.invalid).toMatchObject({ content: "Edited memory", status: "invalid", type: "fact" });
    expect(result.restored).toMatchObject({ content: "Edited memory", status: "active" });
    expect(result.removed).toBe(true);
  } finally {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
