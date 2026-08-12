# DeepWork E2E Tests (Electron + Playwright)

This directory covers critical cross-process IPC paths, such as session
creation, settings persistence, and chat event delivery.

## Prerequisites

1. Build the app: `pnpm build`.
2. Install Playwright dependencies if needed: `pnpm exec playwright install`.
3. Run: `pnpm test:e2e`.

## Test setup

```ts
import { test, expect, _electron as electron } from "@playwright/test";

test("chat:send receives streamed chat:event messages", async () => {
  const app = await electron.launch({ args: ["."] });
  const page = await app.firstWindow();
  // 监听渲染进程事件并断言
  await app.close();
});
```

Each test launches Electron against a fresh temporary HOME directory, so it
never reads or writes the developer's actual DeepWork data.

## Coverage

- [x] Renderer → preload → validated session IPC create/list/delete flow
- [x] Session metadata mutations through preload and SQLite
- [x] Settings persistence across an Electron restart
- [x] Automation create/update/list/runs/delete lifecycle
- [x] Real PTY spawn/input/output/kill lifecycle
- [x] Invalid renderer payload rejection by real IPC validation
- [x] Memory add/edit/invalidate/restore/remove lifecycle
- [ ] `chat:send` → `chat:event` event delivery (requires a deterministic test model)
- [ ] `chat:cancel` affects only the active session
- [ ] User-memory Markdown and timeline file operations
