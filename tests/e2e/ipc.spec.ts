import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startTestModelServer } from "./modelServer";

function launchOptions(home: string): Parameters<typeof electron.launch>[0] {
  const linuxPasswordStore = process.platform === "linux" ? ["--password-store=basic"] : [];
  return {
    args: [".", `--user-data-dir=${path.join(home, "electron")}`, ...linuxPasswordStore],
    env: { ...process.env, HOME: home },
  };
}

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

test("API keys are encrypted, used for verification, and survive restart", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deepwork-e2e-"));
  const modelServer = await startTestModelServer();
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  const secret = `sk-e2e-${Date.now()}-must-not-appear-in-sqlite`;
  try {
    app = await electron.launch(launchOptions(home));
    let page = await app.firstWindow();
    const storage = await app.evaluate(({ safeStorage }) => ({
      available: safeStorage.isEncryptionAvailable(),
      backend: process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : undefined,
    }));
    expect(storage.available).toBe(true);
    if (process.platform === "linux") expect(storage.backend).toBe("basic_text");
    const result = await page.evaluate(async ({ baseUrl, key }) => {
      await window.deepwork.settings.setKey("openai", key);
      const restored = await window.deepwork.settings.getKey("openai");
      const verified = await window.deepwork.models.verify({
        provider: "openai", model: "deepwork-e2e-model", baseUrl, workspaceDir: "",
      });
      return { restored, verified };
    }, { baseUrl: modelServer.baseUrl, key: secret });
    expect(result.restored).toBe(secret);
    expect(result.verified).toMatchObject({ ok: true, models: ["deepwork-e2e-model"] });
    expect(modelServer.authorizationHeaders).toContain(`Bearer ${secret}`);

    await app.close();
    app = undefined;
    const database = fs.readFileSync(path.join(home, "DeepWork", "app", "deepwork.db"));
    expect(database.includes(Buffer.from(secret))).toBe(false);

    app = await electron.launch(launchOptions(home));
    page = await app.firstWindow();
    expect(await page.evaluate(() => window.deepwork.settings.getKey("openai"))).toBe(secret);
  } finally {
    await app?.close();
    await modelServer.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("onboarding configures and verifies a model through the visible UI", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deepwork-e2e-"));
  const modelServer = await startTestModelServer();
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const workspace = path.join(home, "workspace");
    fs.mkdirSync(workspace);
    app = await electron.launch(launchOptions(home));
    const page = await app.firstWindow();
    const card = page.locator(".onboarding-card");
    await expect(card).toBeVisible();
    await card.locator("select").first().selectOption("openai");
    const inputs = card.locator("input");
    await inputs.nth(0).fill("deepwork-e2e-model");
    await inputs.nth(1).fill(modelServer.baseUrl);
    await inputs.nth(2).fill("onboarding-secret");
    await inputs.nth(3).fill(workspace);
    await card.locator(".onboarding-actions button").first().click();
    await expect(card.locator(".verify-result")).toBeVisible({ timeout: 20_000 });
    await expect(card.locator(".verify-result.ok")).toContainText("deepwork-e2e-model");
    await card.locator(".onboarding-actions button").nth(1).click();
    await expect(card).toBeHidden();
    const saved = await page.evaluate(async () => ({
      settings: await window.deepwork.settings.get(),
      key: await window.deepwork.settings.getKey("openai"),
    }));
    expect(saved.settings).toMatchObject({
      onboarded: true,
      model: { provider: "openai", model: "deepwork-e2e-model", baseUrl: modelServer.baseUrl },
    });
    expect(saved.key).toBe("onboarding-secret");
  } finally {
    await app?.close();
    await modelServer.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("model response streams from a real local HTTP server through chat events", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deepwork-e2e-"));
  const modelServer = await startTestModelServer();
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch(launchOptions(home));
    const page = await app.firstWindow();
    const events = await page.evaluate(async ({ baseUrl }) => {
      const settings = await window.deepwork.settings.get();
      await window.deepwork.settings.setKey("openai", "stream-secret");
      await window.deepwork.settings.save({
        ...settings, onboarded: true,
        model: { provider: "openai", model: "deepwork-e2e-model", baseUrl, workspaceDir: "" },
      });
      await window.deepwork.settings.rebuildAgent();
      const session = await window.deepwork.sessions.create("Streaming E2E");
      return new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const received: Array<Record<string, unknown>> = [];
        const timer = setTimeout(() => reject(new Error(JSON.stringify(received))), 20_000);
        const off = window.deepwork.chat.onEvent(session.id, (event) => {
          received.push(event as unknown as Record<string, unknown>);
          if (event.type === "turn_completed" || event.type === "turn_error") {
            clearTimeout(timer);
            off();
            resolve(received);
          }
        });
        void window.deepwork.chat.send(session.id, "Reply without tools", undefined, undefined, undefined, "plan");
      });
    }, { baseUrl: modelServer.baseUrl });
    expect(events.filter((event) => event.type === "message_delta").map((event) => event.text)).toEqual(["E2E ", "stream ", "complete"]);
    expect(events.some((event) => event.type === "turn_completed")).toBe(true);
    expect(events.some((event) => event.type === "turn_error")).toBe(false);
  } finally {
    await app?.close();
    await modelServer.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("artifact open and reveal reach Electron shell with a validated session file", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deepwork-e2e-"));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch(launchOptions(home));
    await app.evaluate(({ shell }) => {
      const state = globalThis as typeof globalThis & { __deepworkE2eShellCalls?: Array<{ action: string; file: string }> };
      state.__deepworkE2eShellCalls = [];
      shell.openPath = async (file: string) => { state.__deepworkE2eShellCalls!.push({ action: "open", file }); return ""; };
      shell.showItemInFolder = (file: string) => { state.__deepworkE2eShellCalls!.push({ action: "reveal", file }); };
    });
    const page = await app.firstWindow();
    const file = await page.evaluate(async () => {
      const session = await window.deepwork.sessions.create("Artifact shell E2E");
      return { sessionId: session.id, rootDir: session.rootDir };
    });
    const artifactPath = path.join(file.rootDir, "report.txt");
    fs.mkdirSync(file.rootDir, { recursive: true });
    fs.writeFileSync(artifactPath, "artifact");
    await page.evaluate(async ({ sessionId, artifactPath }) => {
      await window.deepwork.artifacts.open(sessionId, artifactPath);
      await window.deepwork.artifacts.reveal(sessionId, artifactPath);
    }, { sessionId: file.sessionId, artifactPath });
    const shellCalls = await app.evaluate(() => {
      const state = globalThis as typeof globalThis & { __deepworkE2eShellCalls?: Array<{ action: string; file: string }> };
      return state.__deepworkE2eShellCalls ?? [];
    });
    const canonicalArtifactPath = fs.realpathSync(artifactPath);
    expect(shellCalls).toEqual([
      { action: "open", file: canonicalArtifactPath },
      { action: "reveal", file: canonicalArtifactPath },
    ]);
  } finally {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
