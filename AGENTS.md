# AGENTS.md

Guidance for AI coding agents (Claude Code, Cursor, Copilot, etc.) working in
this repository. Read this before making changes. The README covers what the
app is; this file covers how to change it safely.

## Language

**English is the primary language of this project.** Write everything in English
by default:

- This file and all documentation / markdown.
- All code identifiers (variables, functions, types, modules), comments, commit
  messages, log event names, and error/exception messages.
- `en-US.ts` is the **source of truth** for i18n. User-facing strings must be
  added there first, then mirrored to `zh-CN.ts`. The two locale files must stay
  in sync (same keys); CI/review should catch missing keys.
- Do not leave Chinese (or any other language) hardcoded in components, main-
  process logic, or system prompts. Route user-visible text through `i18n.t()`.
  Chinese-only text belongs only in `zh-CN.ts`.

There is pre-existing Chinese in comments, some strings, and agent prompts that
predates this convention. When you touch such code, translate it as part of your
change (don't add new Chinese); large sweeps can be done as dedicated refactors.

## What this is

DeepWork is a **local-first, cross-platform Electron desktop AI agent**. The
agent core runs in the Electron **main process**; the UI is React in the
**renderer**; the two talk over a typed `contextBridge` in **preload**. The agent
can read/write files, run commands, drive the screen (screenshot + mouse/
keyboard as a GUI fallback), and load MCP plugins. All of those are powerful and
dangerous, so **security is the dominant concern** in `src/main`.

## Commands

```bash
pnpm install
pnpm dev            # electron-vite dev with hot reload
pnpm typecheck      # tsc on BOTH tsconfig.node.json and tsconfig.web.json
pnpm test           # vitest run (unit/integration, no Electron)
pnpm test:watch
pnpm test:e2e       # playwright (requires a built app)
pnpm build          # typecheck + electron-vite build
pnpm dist           # package with electron-builder
```

- Requires **Node 22+** and **pnpm**. Do not introduce npm/yarn lockfiles.
- `pnpm typecheck` and `pnpm test` **must pass** before finishing a change.
  Both typecheck configs matter — code under `src/main`, `src/preload`,
  `src/shared` is checked by `tsconfig.node.json`; `src/renderer` by
  `tsconfig.web.json`.

## Architecture / process boundaries

```
src/
  main/        Electron main: agent, tools, MCP, storage, security, IPC, automation
    agent/     LangChain/deepagents model construction, agent manager, embeddings
    tools/     Tool implementations + the risk registry + SSRF guard
    security/  Approval gate
    storage/   SQLite access, settings, sessions, memories, automations
    ipc/       ipcMain handlers (the trust boundary from renderer)
    automation/ Cron/daily/weekly scheduler
    skills/    Agent Skills on-disk store
    terminal/  node-pty manager
    mcp/       MCP server lifecycle
    config/    Paths, env
    log/       Structured logger + global fetch logging wrapper
  preload/     contextBridge API — the ONLY surface the renderer may call
  renderer/    React UI (src/renderer/src)
  shared/      Types and i18n strings shared across processes
```

Hard rules:

- **The renderer is untrusted.** Treat every IPC argument as attacker-controlled
  (the threat model is a compromised renderer / XSS). Validate and narrow types
  at the `ipc/register.ts` boundary. Never pass `any`-shaped renderer data
  straight into `fs`, `child_process`, `fetch`, or SQL.
- **No Node APIs in the renderer.** It must go through the preload bridge.
- **No direct SQL string interpolation.** Always use better-sqlite3 bound
  parameters (`?` placeholders).
- IPC channels are `namespace:verb`. Preload bindings live in
  `src/preload/index.ts` and mirror those names exactly.

## Security model — read before touching tools, IPC, or network

1. **Every tool has a risk level** (`src/main/tools/registry.ts`):
   `read < write < exec < external`. The approval gate in
   `src/main/security/approvals.ts` decides per permission mode. A tool's risk
   can only be **raised, never silently lowered**. When adding a tool, pick the
   correct risk and register it via `defineTool(risk, ...)`. GUI/screen tools
   always require per-use approval regardless of mode.
2. **SSRF guard** (`src/main/tools/webGuard.ts`): any user/renderer-supplied URL
   that reaches `fetch` must pass validation. There are two guards:
   - `assertPublicUrlResolved` — for the `web_fetch` tool: blocks all
     non-public hosts and is re-run on **every redirect hop**.
   - `assertConfiguredEndpoint` — for configured model/embedding endpoints:
     allows loopback/private (local Ollama) but blocks link-local/cloud-metadata
     (169.254/16, fe80::/10, IPv4-mapped variants, `fd00:ec2::254`). Enforce it
     at **save time** (see `assertSettingsEndpoints` in `ipc/register.ts`), not
     only on the verify/test path.
   - These guards **fail closed** on DNS errors. Do not revert that. If you add
     a new outbound-HTTP path, route it through the appropriate guard and handle
     redirects (use `redirect: "manual"` + re-validate, as `web.ts` does).
3. **Path traversal:** anything that turns an external string into a filesystem
   path must be validated first. Skill names go through `assertValidName`
   (strict kebab-case slug). Reuse existing guards rather than inventing new
   path checks.
4. **Secrets:** API keys are stored encrypted via Electron `safeStorage`
   (`setApiKey`/`getApiKey` in `storage/settings.ts`). Never log keys,
   Authorization headers, or query strings. The HTTP logger only records
   host/path/status/timing — keep it that way. Never hardcode secrets.

## Storage and migrations

- SQLite is accessed synchronously via `better-sqlite3` through `getDb()` in
  `src/main/storage/db.ts`.
- The schema is defined authoritatively in the `CREATE TABLE IF NOT EXISTS`
  statements in `migrate()`. The app has not shipped a stable release yet, so
  there is no in-place upgrade/migration framework — just edit the `CREATE TABLE`
  statements directly. When you add a NOT NULL column, give it a DEFAULT.
  Once a version is released, reintroduce an additive migration path (e.g. an
  `addColumn`/`PRAGMA table_info` helper) before changing the schema.
- Keep the column-list assertions in `db.test.ts` in sync.
- Settings are cached in memory and invalidated by `saveSettings()`. Hydrate
  `memories` from the durable store on every `loadSettings()` — don't cache it.

## TypeScript conventions

- **Strict TypeScript, no `any` unless unavoidable** (and if used, justify with a
  comment and narrow it at the boundary). Prefer `unknown` + a type guard for
  untrusted input.
- Use `asserts` type predicates for runtime guards (e.g.
  `assertValidName(name: unknown): asserts name is string`).
- Shared types go in `src/shared/types.ts`. Don't duplicate types across
  processes; import from `shared`.
- Zod defines tool input schemas (`src/main/tools/*`).
- No barrels/index files that re-export everything; import directly from the
  module that owns the symbol.

## UI / renderer conventions

- React 19 + function components + hooks. Co-locate component tests as
  `*.test.tsx`.
- **All user-visible strings go through i18n.** Add the key to
  `src/shared/i18n/en-US.ts` (canonical) first, then mirror it in `zh-CN.ts`.
  Use `useTranslation()` / `i18n.t()`. Never hardcode Chinese or English in
  components — every literal a user sees must be an i18n key. (Legacy inline
  strings still exist; migrate them when you touch the surrounding code.)
- The renderer never touches Node; call `window.deepwork.*` (the preload API).
  If you need a new capability, add the IPC handler in `main`, expose it in
  `preload/index.ts`, and call it from the renderer — in that order.
- Markdown is rendered with `react-markdown` + `remark-gfm`; sanitize/trust
  model output accordingly (it is untrusted data).

## Logging

Use the structured logger (`src/main/log/logger.ts`):
`logger.debug|info|warn|error(scope, event, { fields })`.
- `scope` is a short subsystem name (`"session"`, `"automation"`, `"http"`).
- Log object fields, not interpolated strings, for structured output.
- Never log secrets, full prompt bodies, or user file contents.

## Testing

- Tests use **Vitest** and are **co-located**: `foo.ts` next to `foo.test.ts`.
- Prefer real logic with mocked I/O boundaries. Mock the `storage` layer or
  `dns.lookup`, not whole subsystems, when you can.
- When a known bug/gap can't be fixed in the same change, encode it as
  `it.todo("...")` with a reference tag (e.g. `C-A2 DNS SSRF`) rather than
  leaving an untested hole; flip it to `it(...)` when fixed.
- Security-sensitive code (SSRF, path guards, approval gate, cron matching,
  migrations) must have regression tests. A fix for a security issue should
  ship with a test that fails without the fix.
- There is an in-repo convention of tagging notable fixes/concerns in comments
  with codes like `C-T1`, `H-S2`, `M-Agent③` (C/H/M = severity tier from a past
  review, subsystem suffix). These are optional but useful when referring to a
  specific reviewed finding; don't strip them when editing nearby code.

## Error handling

- Validate early at boundaries and throw descriptive `Error`s; let the IPC/agent
  layer translate them to user-facing messages.
- Don't silently swallow errors. If a catch is intentional (e.g. best-effort
  cleanup), leave a comment saying why. `logger.warn/error` anything that
  indicates a real fault.
- Long-running/background loops (scheduler ticks, HTTP) must guard against
  overlapping runs and never reject unhandled — the scheduler uses a
  `ticking` lock and fire-and-forget `launch()` with internal catch; follow
  that pattern.

## Agent / model specifics

- Model clients are built in `src/main/agent/model.ts` via `createChatModel`.
  Credentials resolve with precedence: stored settings → standard env vars
  (`ANTHROPIC_API_KEY`, etc.). No hardcoded keys.
- The coding-tuned model endpoint may not support `model.invoke()` with a system
  role; use `model.stream([new HumanMessage(prompt)], ...)` for one-shot
  extraction tasks (see memory extraction / title generation in
  `agent/manager.ts`). Check existing call sites before assuming `invoke` works.
- The global `fetch` is wrapped for logging. SDKs that capture `fetch` at
  construction time must be passed `globalThis.fetch` explicitly (see
  `resolveOpenAICompat`).

## Git / commits

- Conventional Commits in English: `feat(scope):`, `fix(scope):`, `chore:`,
  `refactor(scope):`, `test:`, `i18n:`. Use `fix(security):` for security fixes.
- Scope is the subsystem (`sessions`, `security`, `automation`, `chat`,
  `settings`, `build`).
- Keep commits focused; don't mix refactors with behavior changes.
- The main branch is `main`; active work happens on `dev`. Don't push to `main`
  unless asked.
- Don't commit generated build output (`out/`, `dist/`, `release/`) or
  `node_modules`.

## Before you finish

1. `pnpm typecheck` passes (both configs).
2. `pnpm test` passes.
3. New IPC surface is mirrored in preload and validated in the handler.
4. New outbound network/path/exec calls go through the appropriate guard.
5. User-visible strings are in both i18n locales.
6. Security- or storage-schema-changing work has a test (and a migration once a
   version is released).
7. Summarize what changed and call out anything risky or unverified — don't
   claim a fix is verified unless you actually ran it.
