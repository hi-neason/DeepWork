import { defineConfig } from "@playwright/test";

/**
 * Electron E2E 配置（关键 IPC 链路，如 chat:send → chat:event）。
 *
 * 运行前提：先 `pnpm dist` 构建出可启动的应用；再 `pnpm test:e2e`。
 * 用例内用 `@playwright/test` 的 `_electron.launch(...)` 启动应用，
 * 通过 `electronApp` 拿到主进程 / 首个 BrowserWindow 的 page 做交互断言。
 *
 * Phase 0 仅就位结构，tests/e2e 下尚未编写具体用例。
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
});
