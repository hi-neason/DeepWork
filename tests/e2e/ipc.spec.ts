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
