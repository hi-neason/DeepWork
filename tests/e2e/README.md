# DeepWork E2E 测试（Electron + Playwright）

本目录用于**关键 IPC 链路**的端到端测试，例如 `chat:send → chat:event`、
设置读写、记忆/时间线读写等跨进程行为。

## 运行前提

1. 构建应用：`pnpm dist`（产出可启动的打包产物）。
2. 安装浏览器（首次）：`pnpm exec playwright install`。
3. 执行：`pnpm test:e2e`。

## 用例骨架

```ts
import { test, expect, _electron as electron } from "@playwright/test";

test("chat:send 能收到 chat:event 流式事件", async () => {
  const app = await electron.launch({ args: ["."] });
  const page = await app.firstWindow();
  // 监听渲染进程事件并断言
  await app.close();
});
```

## 覆盖范围（后续阶段补齐）

- [ ] `chat:send` → `chat:event` 完整流转（含 tool_call / approval_requested）
- [ ] `chat:cancel` 仅取消当前会话
- [ ] 设置项持久化（reload 后仍在）
- [ ] 用户记忆 / 时间线读写
