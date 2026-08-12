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
  // Subscribe in the renderer and assert events from the main process.
  await app.close();
});
```

Each test launches Electron against a fresh temporary HOME directory, so it
never reads or writes the developer's actual DeepWork data.

Headless Linux CI has no desktop keyring. The E2E launcher therefore selects
Electron's `basic_text` password backend only on Linux test processes. The
API-key test asserts that this backend is active before exercising
`safeStorage`; production startup flags and its fail-closed secret policy are
unchanged.

## Coverage

- [x] Renderer → preload → validated session IPC create/list/delete flow
- [x] Session metadata mutations through preload and SQLite
- [x] Settings persistence across an Electron restart
- [x] Automation create/update/list/runs/delete lifecycle
- [x] Real PTY spawn/input/output/kill lifecycle
- [x] Invalid renderer payload rejection by real IPC validation
- [x] Memory add/edit/invalidate/restore/remove lifecycle
- [x] Encrypted API-key save, verification use, restart restore, and plaintext absence
- [x] Visible onboarding model/key/workspace verification and completion
- [x] `chat:send` → `chat:event` streaming through a deterministic local HTTP/SSE model
- [x] Validated artifact open/reveal calls reaching Electron's system shell boundary
- [ ] `chat:cancel` affects only the active session
- [ ] User-memory Markdown and timeline file operations
