# Test Coverage Audit

This document is the acceptance baseline for DeepWork test coverage. Passing
the current test suite is not sufficient unless the relevant rows below are
covered.

## Required scenario classes

Every user action and IPC endpoint must cover each applicable scenario class:

| Code | Scenario | Examples |
| --- | --- | --- |
| H | Happy path | Valid input, expected state and side effects |
| E | Empty and optional data | Empty lists, omitted arguments, cancellation |
| B | Boundary data | Maximum lengths/counts, dates, sizes, numeric limits |
| I | Invalid or forged data | Wrong types, unknown keys, traversal, malformed URLs |
| N | Missing resource | Unknown session, model, automation, skill, or file |
| D | Dependency failure | Database, filesystem, model, network, keychain, dialog failure |
| C | Concurrency and lifecycle | Double click, overlapping request, cancellation, unmount/restart |
| P | Persistence and restart | Save, reload, migration, encrypted-secret continuity |

`N/A` must be justified by the test author. A single happy-path assertion does
not complete an endpoint or page.

## Page and component audit

Status meanings: **partial** has at least one focused test; **missing** has no
direct functional test. Child components mocked out by a parent test are not
considered covered.

### Implementation update (2026-08-12)

The first systematic implementation batch added 61 regression and scenario
tests (246 → 307) and introduced direct coverage for General settings, Models,
Memory, About/update, Onboarding, automation persistence, and settings/key
persistence. It also moved renderer-controlled arguments for sessions, skills,
settings keys, models, approvals, memories, artifacts, automations, and terminal
operations behind Zod validation. Rows below intentionally retain remaining
gaps until every listed scenario is implemented.

The second page-focused batch raised the suite to 47 files / 325 tests and
added direct coverage for Sidebar conversations and automation runs, Skills,
Connectors, Terminal lifecycle and its error boundary, plus Markdown rendering
and raw-HTML safety. Production build and Electron E2E were rerun after both
batches.

The third lifecycle/boundary batch raised the suite to 50 files / 346 tests.
It covers CommitRunner animation cleanup and input guards, browser attachment
classification/read failures, Settings debounce and failed-save rollback,
RightPanel artifact actions, and preload invocation/event subscription
forwarding and cleanup.

The fourth cross-process batch raised the suite to 357 unit/integration tests
and 7 real Electron E2E tests. It covers session and metadata persistence,
settings across an application restart, automation CRUD and run history, PTY
input/output/termination, forged IPC rejection, and the structured-memory
lifecycle through preload, main, and SQLite. CI now enforces typecheck, unit
tests, production build, and headless Electron E2E. These journeys also exposed
and fixed omitted automation `enabled` defaults and memory edits clearing
existing type/importance metadata.

| Surface | Current | Required functional coverage gaps |
| --- | --- | --- |
| App shell and navigation | Partial | Initial load failure, new/open/delete task, view switching, update events, onboarding routing, persisted panel state, event cleanup |
| Onboarding | Missing | Provider/model variants, key-required and keyless providers, verification success/failure, directory cancel, save/rebuild failure, completion persistence |
| Sidebar: conversations | Missing | Empty/grouped lists, search, select, rename, delete, group CRUD, recent changes, context-menu dismissal, IPC failures |
| Sidebar: automation runs | Missing | Empty/loading/error, filter, expand/collapse, select run, delete one/all runs, failed run indicators |
| Chat composer | Partial | Large text, every attachment kind and limit, folder/mode menus, slash skills, send/cancel failure, keyboard behavior; empty input, streaming double-submit guard, cancellation, model refresh/select/add, and new-task workspace selection are covered |
| Chat timeline | Partial | All event/segment types, reasoning visibility, tool/approval states, copy/regenerate, malformed Markdown, untrusted links/content, long streams |
| Image preview | Missing | Open/close/escape/backdrop, missing data, accessible labeling |
| Approval card | Partial | Unavailable decisions, repeated response, IPC failure; allow/always allow/deny are covered through Chat |
| Right panel | Partial | Empty/loading/error artifacts, refresh, reveal/open failures, progress states, stale session changes |
| Terminal panel | Missing | Spawn/input/resize/data/kill, spawn failure, unmount cleanup, session change, resize storm, error boundary recovery |
| Settings shell | Partial | Load/save/apply/rebuild failure, debounce races, close while saving, reload after failure, every tab route |
| Settings: General | Missing | Every toggle, theme/language/font boundaries, default/custom workspace, picker cancel/failure |
| Settings: Models | Missing | Add/edit/delete/default/enable, all providers, duplicate IDs, key save/retain/clear/decrypt failure, verify success/failure, custom endpoints |
| Settings: Connectors | Missing | Add/edit/delete/toggle/import, stdio/SSE variants, malformed import, connection status, trust rejection, persistence failure |
| Settings: Skills | Missing | Create/edit/rename/delete/toggle/import/export, invalid names, duplicates, picker cancel, storage/rebuild failures |
| Settings: Automations | Partial | Create/edit/delete/run, all schedule types, invalid dates/cron, filters, skills/MCP/model/workspace selectors, optimistic rollback, double actions |
| Memory: structured | Missing | Empty/all statuses, invalidate/restore, loading and persistence failures |
| Memory: user Markdown | Missing | Load/edit/reset/save, empty/large/malformed content, path/load/save failure, dirty-state lifecycle |
| Memory: timeline | Missing | Empty dates, selection, invalid date, missing file, rapid selection race |
| Memory: project | Missing | Empty projects, selection, invalid project, missing file, rapid selection race |
| Settings: About/update | Missing | Version/path load, reveal, checking/available/progress/downloaded/error/not-available, install failure |
| Markdown renderer | Missing | GFM, code, links, images, unsafe HTML/URLs, huge/malformed content |
| CommitRunner animation | Missing | Reduced motion, theme changes, resize, keyboard/pointer/touch lifecycle and cleanup |
| Terminal error boundary | Missing | Child throw, close, retry/remount behavior |

## IPC endpoint audit

The columns list the scenario classes that still require explicit endpoint-level
tests. `Covered` only records meaningful current coverage, not incidental string
mentions in a test.

### Sessions and chat

| Endpoint | Covered | Missing |
| --- | --- | --- |
| `sessions:list` | — | H,E,D |
| `sessions:get` | — | H,I,N,D |
| `sessions:create` | H,E | B,I,D,P |
| `sessions:rename` | — | H,E,B,I,N,D |
| `sessions:delete` | — | H,I,N,D,C |
| `sessions:setGroup` | — | H,E,B,I,N,D |
| `sessions:setWorkspace` | I | H,E,N,D,P |
| `sessions:setModel` | — | H,E,B,I,N,D |
| `sessions:setPermissionMode` | I | H,N,D |
| `sessions:groups` | — | H,E,D |
| `sessions:recentFolders` | — | H,E,B,D |
| `sessions:renameGroup` | — | H,E,B,I,N,D |
| `sessions:deleteGroup` | — | H,I,N,D |
| `sessions:createGroup` | — | H,E,B,I,D |
| `chat:history` | — | H,E,I,N,D,C |
| `chat:status` | H | I,N,D |
| `chat:send` | H,I,D | E,B,N,C; attachment matrix; all event types |
| `chat:cancel` | H | I,N,C,D |
| `chat:regenerate` | H,D | I,N,C; all event types |
| `approval:respond` | — | H,I,N,D,C; every decision |

### Settings, models, application, and updates

| Endpoint | Covered | Missing |
| --- | --- | --- |
| `settings:get` | — | H,D,P; corrupt/legacy settings |
| `settings:save` | H,I,D | E,B,C,P; every provider/MCP combination |
| `settings:getKey` | — | H,E,I,D,P; unavailable/decrypt failure |
| `settings:setKey` | — | H,E,B,I,D,P; overwrite and explicit delete |
| `settings:pickDirectory` | — | H,E,D; window unavailable |
| `settings:rebuildAgent` | — | H,D,C |
| `settings:setOnboarded` | — | H,I,D,P |
| `settings:applySystem` | — | H,D; all preference combinations |
| `models:catalog` | — | H,E; schema invariants and unique IDs |
| `models:providers` | — | H; preset completeness and endpoint validity |
| `models:verify` | — | H,E,B,I,D; every provider/auth/status/timeout |
| `app:dataPath` | — | H |
| `app:revealData` | — | H,D |
| `app:version` | — | H |
| `updates:check` | — | H,D,C; every updater event and no-update result |
| `updates:install` | — | H,D |

### Skills and MCP

| Endpoint | Covered | Missing |
| --- | --- | --- |
| `skills:list` | — | H,E,D |
| `skills:create` | — | H,E,B,I,D; duplicate name |
| `skills:update` | — | H,E,B,I,N,D; forged patch keys |
| `skills:delete` | — | H,I,N,D |
| `skills:rename` | — | H,E,B,I,N,D; collision |
| `skills:import` | — | H,E,I,N,D; traversal/symlink/collision |
| `skills:export` | — | H,E,I,N,D; traversal/symlink/collision |
| `skills:rebuild` | — | H,D,C |
| `mcp:status` | — | H,E,D; mixed server outcomes |

### Memories

| Endpoint | Covered | Missing |
| --- | --- | --- |
| `memories:list` | — | H,E,D; include-invalid variants |
| `memories:listByScope` | — | H,E,B,I,D; every type |
| `memories:search` | — | H,E,B,I,D; topK boundaries |
| `memories:add` | — | H,E,B,I,D; every type/scope |
| `memories:edit` | H,P | E,B,I,N,D; existing type/importance preservation is covered |
| `memories:remove` | — | H,I,N,D |
| `memories:invalidate` | — | H,I,N,D; repeated operation |
| `memories:restore` | — | H,I,N,D; repeated operation |
| `userMemory:read` | — | H,E,D; unknown sections |
| `userMemory:save` | — | H,E,B,I,D,P; unknown sections |
| `userMemory:append` | — | H,E,B,I,D,C |
| `userMemory:raw` | — | H,E,D |
| `userMemory:saveRaw` | — | H,E,B,I,D,P |
| `userMemory:path` | — | H |
| `timeline:list` | — | H,E,D |
| `timeline:read` | I | H,E,N,D; leap-day/date boundaries |
| `timeline:path` | I | H,N,D; leap-day/date boundaries |
| `projectMemory:list` | — | H,E,D |
| `projectMemory:read` | I | H,E,N,D; length boundaries |
| `projectMemory:path` | — | H,I,N,D; length boundaries |

### Artifacts, automations, and terminal

| Endpoint | Covered | Missing |
| --- | --- | --- |
| `artifacts:list` | — | H,E,I,N,D |
| `artifacts:reveal` | I | H,N,D; symlink and sibling-prefix escapes |
| `artifacts:open` | H,I | N,D; symlink and sibling-prefix escapes |
| `automations:list` | — | H,E,D |
| `automations:listWithRuns` | — | H,E,D; mixed statuses |
| `automations:create` | H,E,P | B,I,D; every schedule type (omitted enabled defaults to true) |
| `automations:update` | H,I | E,B,N,D,C; every mutable field |
| `automations:delete` | — | H,I,N,D,C |
| `automations:runs` | — | H,E,I,N,D |
| `automations:deleteRun` | — | H,I,N,D |
| `automations:deleteRuns` | — | H,I,N,D |
| `automations:runNow` | H,N | I,D,C; enabled/paused/auto-paused variants |
| `terminal:spawn` | H,I,N | D,C; default/project workspaces |
| `terminal:input` | — | H,E,B,I,N,D |
| `terminal:resize` | I | H,B,N,D,C |
| `terminal:kill` | — | H,I,N,D; repeated kill |

## Non-IPC runtime gaps

| Runtime area | Missing coverage |
| --- | --- |
| macOS development bundle | Assert returned executable is inside a bundle whose basename is exactly `DeepWork.app`; cache hit/miss; icon/version fingerprint change; signing/copy failure; non-macOS passthrough |
| Safe Storage | Encryption unavailable; encrypt/decrypt failure; malformed envelope; old ciphertext; overwrite/delete; no secret in logs/settings blob |
| Scheduler | All schedule types/timezones/DST, overlap lock, retry boundaries, event failures, auto-pause/re-enable, restart deduplication |
| Logger | Custom/default path, global/session paths, mkdir failure, serialization limits; disabled state, write failure recovery, metadata redaction, and write ordering are covered |
| Preload event subscriptions | Session filtering, any-session delivery, unsubscribe, duplicate listeners, malformed event payload |

## Enforcement plan

1. Add direct component tests for every **missing** page before considering UI
   work complete.
2. Convert renderer-controlled raw IPC handlers to validated handlers and add
   parameterized H/E/B/I/N/D tests for each endpoint.
3. Extend the existing Electron E2E journeys with onboarding, model/key
   configuration, model-backed conversation streaming, and artifact shell
   integration. Session, automation, memory, settings restart, terminal, and
   invalid-IPC journeys are now enforced.
4. Keep `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm test:e2e`
   mandatory in CI; Electron E2E is no longer an optional local-only suite.
5. Require every bug fix to include a regression test that fails on the parent
   revision, plus adjacent boundary and dependency-failure cases.
