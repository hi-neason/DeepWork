# DeepWork

A local-first, cross-platform personal desktop AI agent. It lives in a chat
window, can read/write files and run commands, operates the screen (screenshot
+ mouse/keyboard) as a fallback, and extends its abilities through MCP plugins.

See [`docs/plans/2026-08-02-deepwork-design.md`](docs/plans/2026-08-02-deepwork-design.md)
for the full design.

## Stack

- **Shell:** Electron + TypeScript (agent core runs in the main process)
- **UI:** React
- **Agent:** [deepagentsjs](https://github.com/langchain-ai/deepagentsjs) + LangChain.js / LangGraph
- **Plugins:** MCP via `@langchain/mcp-adapters`
- **Models:** Anthropic / OpenAI-compatible / Ollama (configurable)
- **Storage:** SQLite (sessions, settings, audit) + LangGraph SQLite checkpointer
- **GUI fallback:** Electron `desktopCapturer` (screenshot) + `@nut-tree-fork/nut-js` (mouse/keyboard)

## Development

Requires Node 22+ and pnpm.

```bash
pnpm install
pnpm dev        # launch Electron with hot reload
```

Production build:

```bash
pnpm build      # typecheck + electron-vite build
pnpm dist       # package with electron-builder
```

## First run

1. Open **Settings** (bottom of the sidebar).
2. Choose a provider and enter its API key (or point Ollama at a local model).
3. Optionally pick a workspace directory and add MCP servers.
4. Start a chat.

Consequential actions (file writes, commands, network, and **all** GUI
actions) ask for approval before running.

## Project layout

```
src/
  main/          # Electron main process: agent, tools, MCP, storage, security, IPC
  preload/       # contextBridge API exposed to the renderer
  renderer/      # React UI
  shared/        # types shared across processes
```
