import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// DeepWork 测试配置（vitest）。
//
// 环境策略：
//  - 默认 environment: "node" —— 主进程 / 共享 / preload 的纯逻辑。
//  - 渲染进程组件测试在文件顶部加一行 `// @vitest-environment jsdom`
//    即可切到 DOM 环境（同时可用 @renderer 别名）。
//
// 之所以不用 vitest 的 projects 多环境，是因为在当前 vitest 版本下
// 根 runner 与 project 会各跑一遍用例（重复执行）。单配置 + 文件级
// environment 声明更可靠、只执行一次。
//
// E2E（Electron + Playwright）走独立的 playwright.config.ts，不经 vitest。
export default defineConfig({
  resolve: {
    alias: { "@renderer": resolve(__dirname, "src/renderer/src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/tests/e2e/**"],
    restoreMocks: true,
    clearMocks: true,
  },
});
