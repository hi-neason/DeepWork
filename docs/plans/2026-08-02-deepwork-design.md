# DeepWork 设计文档

> 版本：v0.0.1（初稿）
> 日期：2026-08-02
> 状态：待评审

## 1. 产品定位

DeepWork 是一个**本地优先的跨平台个人桌面 Agent 助手**。它住在你的电脑里，通过一个常驻聊天窗口接收指令，能读写文件、执行命令、操作浏览器，并在工具覆盖不到时通过截屏 + 键鼠控制兜底操作任意桌面应用。专业领域能力通过插件扩展——插件遵循 MCP 协议，任何 MCP server 都可以接入。

设计原则：

- **工具调用为主，GUI 操作为兜底**：结构化工具快、稳、可审计；屏幕操作慢、有风险，仅在没有工具可用时使用。
- **本地优先、单用户**：数据、密钥、对话都在本机，不依赖云端服务（模型调用除外，可配置）。
- **可插拔**：核心提供 Agent 循环与一组基础能力，其余专业能力通过 MCP 插件获得。
- **人在回路**：有副作用的操作按风险分级，高风险操作执行前需用户确认。

## 2. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面外壳 | **Electron** | 跨平台窗口、托盘、自动更新，生态成熟 |
| 语言/构建 | **TypeScript + pnpm + electron-vite** | UI 与内核同一套技术栈 |
| 前端 UI | **React** | 聊天界面（组件库待定，先从轻量方案起步） |
| Agent 引擎 | **deepagentsjs + LangChain.js v1 + LangGraph** | 提供 Agent 循环、流式、中间件、checkpoint、HITL |
| MCP 插件 | **@langchain/mcp-adapters + @modelcontextprotocol/sdk** | 作为 MCP client 加载外部 server |
| 模型层 | LangChain `BaseChatModel` | OpenAI / Anthropic / Gemini / Ollama 等，可配置 |
| 持久化 | **better-sqlite3** | 会话、checkpoint、配置、审计日志 |
| GUI 兜底 | **nut.js**（键鼠/截屏，跨平台）+ 各平台无障碍 API 按需补充 | 核心差异化能力 |
| 浏览器自动化 | **Playwright**（可选能力插件） | 操作网页应用 |

## 3. 进程模型

单进程内嵌内核：

```
┌─────────────────────────────────────────────────────┐
│  Electron 主进程 (Node.js)                           │
│  ┌───────────────────────────────────────────────┐  │
│  │  Agent 内核 (deepagentsjs)                     │  │
│  │  - Agent 循环 / LangGraph                      │  │
│  │  - 工具注册（内置 + GUI + MCP 插件）            │  │
│  │  - 权限闸门 / HITL                             │  │
│  │  - MCP client / server 生命周期管理            │  │
│  │  - SQLite checkpoint + 审计                    │  │
│  └───────────────────────────────────────────────┘  │
│         │ IPC (contextBridge / webContents)          │
│  ┌──────▼────────────────────────────────────────┐  │
│  │  渲染进程 (React)                              │  │
│  │  聊天窗口 / 工具状态 / 授权弹窗 / 设置          │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

内核直接跑在 Electron 主进程，通过 contextBridge 暴露一个安全的 API 给渲染进程，流式事件通过 `webContents.send` 推送。MCP server 作为独立子进程由主进程 spawn 和监督。

> 注：Agent 长循环虽然是异步 I/O，但为避免阻塞主进程影响窗口响应，重型工具（浏览器、大批量文件处理）放在 utility process 或 Worker 中执行。

## 4. 分层架构

```
┌─────────────────────────────────────────────────┐
│  表现层 (renderer / React)                        │
│  对话流、工具调用卡片、审批对话框、设置/插件管理    │
└───────────────────────┬─────────────────────────┘
                    IPC (typed)
┌───────────────────────▼─────────────────────────┐
│  应用层 (main / services)                        │
│  - 会话管理  - MCP 插件管理  - 配置/密钥          │
│  - 权限策略  - 审计日志  - 窗口/托盘/通知          │
└───────────────────────┬─────────────────────────┘
                        │ 装配
┌───────────────────────▼─────────────────────────┐
│  Agent 内核 (deepagentsjs)                       │
│  createDeepAgent + 自定义中间件                   │
│  - 事件流  - HITL 审批  - 上下文压缩  - 记忆      │
└───────┬───────────────┬───────────────┬─────────┘
        │               │               │
┌───────▼──────┐ ┌──────▼──────┐ ┌──────▼─────────┐
│ 内置工具      │ │ GUI 兜底工具 │ │ MCP 插件工具    │
│ 文件/shell/  │ │ 截屏/键鼠/  │ │ (外部子进程，   │
│ 搜索/记忆…   │ │ 无障碍      │ │  任意 MCP server)│
└──────────────┘ └─────────────┘ └────────────────┘
```

应用层负责"DeepWork 是什么"，内核层负责"Agent 怎么跑"，工具层负责"Agent 能做什么"。

## 5. Agent 内核

基于 `createDeepAgent` 装配：

- **循环**：ReAct 式（模型 → tool_calls → 执行 → 回灌），由 LangGraph 驱动。配置合理的 `recursionLimit`（远低于默认的 10000，建议 ~50）。
- **流式事件**：主进程订阅 `agent.stream()`，将文本增量、思考、工具调用、工具结果归一化成一组 DeepWork 事件，通过 IPC 推给渲染进程。
- **审批（HITL）**：对高风险工具配置 `interruptOn`，工具执行前中断。主进程收到中断后弹授权对话框，用户选择允许/拒绝/改参数，用 `Command({ resume })` 恢复。状态持久化在 checkpointer，用户离开再回来也能继续。
- **上下文压缩**：用 `createSummarizationMiddleware`，长对话自动摘要，避免 token 爆掉。
- **中间件**：自定义中间件实现工具风险标注、审计记录、事件桥接。默认中间件可按 name 替换。

### 内核 API 草图

```ts
// main/agent/runner.ts
export async function* runTurn(
  threadId: string,
  userText: string,
): AsyncIterable<DeepWorkEvent> {
  const agent = getOrCreateAgent(threadId);
  const config = { configurable: { thread_id: threadId }, signal };
  const stream = await agent.stream(
    { messages: [{ role: "user", content: userText }] },
    { streamMode: "messages", subgraphs: true, ...config },
  );
  for await (const [, chunk] of stream) {
    yield* mapChunkToEvents(chunk);
  }
}
```

## 6. 工具系统

所有工具是标准 LangChain `tool()`（Zod schema 定义参数），分三类：

### 6.1 内置工具

文件读写、shell 执行、内容搜索、记忆（remember/recall）、网络请求等。直接使用 deepagents 的 `LocalShellBackend` / `FilesystemBackend`，但默认收紧工作目录到用户授权的 workspace。

### 6.2 GUI 兜底工具（核心差异化）

- `screenshot`：截取屏幕（主显示器/指定区域/窗口），返回图片给模型。
- `mouse_click` / `mouse_move` / `mouse_scroll`：鼠标操作。
- `keyboard_type` / `keyboard_press`：键盘输入与快捷键。
- `ui_inspect`：通过各平台无障碍 API 获取当前前台窗口的可访问元素树（比纯截屏坐标更稳），作为模型定位元素的结构化依据。

实现路线：先用 nut.js 做跨平台键鼠和截屏；无障碍元素树按平台逐步实现（macOS AX API → Windows UI Automation → Linux AT-SPI）。

**GUI 工具一律视为高风险**：默认每次执行前都要审批，且在屏幕上给用户明显的视觉提示（高亮即将点击的位置），防止误操作。

### 6.3 MCP 插件工具

通过 `@langchain/mcp-adapters` 的 `MultiServerMCPClient` 加载。每个 MCP server 的工具自动注册给 Agent。DeepWork 负责：

- server 配置的增删改（命令、参数、环境变量、传输方式）
- server 进程的启动、健康检查、重启、停止
- 工具级 enable/disable
- 核心 server 自带（文件系统、fetch 等），用户可手动添加任意 MCP server

插件市场/注册表不在 v0.0.1 范围。

## 7. 模型层

不锁定厂商。`model` 接受任意 LangChain `BaseChatModel` 实例：

- 预置 OpenAI、Anthropic、Gemini、Ollama（本地）的配置项
- 支持自定义 OpenAI 兼容 endpoint（baseURL + apiKey）
- API Key 存在系统密钥链（Electron `safeStorage`）或加密本地文件，不进模型上下文、不进日志
- v0.0.1 先支持在设置里选默认模型；mid-session 切换和多 provider fallback 留到后续版本

> 遥测：不配置 langsmith key，关闭数据外发。

## 8. 权限与安全

借鉴 OpenWorker 的分级思想，用一套简单可落地的模型：

- **工具风险等级**：`read`（只读，自动放行）、`write`（改动本机文件/状态，需确认或会话内记住）、`exec`（执行命令/GUI 操作，每次确认）、`external`（发网络请求/发消息，确认）。
- **审批粒度**：单次允许 / 本会话始终允许此工具 / 拒绝。
- **GUI 工具**：强制每次确认，不可"始终允许"。
- **工作区边界**：文件工具默认只能访问用户授权的目录；shell 命令不做 shell 操作符拼接。
- **审计日志**：每个工具调用的参数、时间、审批结果、输出摘要写 SQLite，可在设置里回看。
- **MCP workspace 信任**：从项目目录发现的 MCP 配置需用户显式信任才启动，防止恶意仓库自动拉起进程。

v0.0.1 不做 OS 级沙箱（容器/VM），安全靠权限门控 + 审计。后续可加可选沙箱。

## 9. 数据与存储

所有数据在本机，目录按平台约定：

- macOS：`~/Library/Application Support/DeepWork/`
- Windows：`%APPDATA%/DeepWork/`
- Linux：`~/.config/DeepWork/`

内容：

| 数据 | 存储 |
|---|---|
| 会话与消息 | SQLite |
| LangGraph checkpoint | SQLite（better-sqlite3 checkpointer） |
| 配置（模型、MCP、偏好） | SQLite / JSON 文件 |
| API Key / 令牌 | 系统密钥链（safeStorage） |
| 审计日志 | SQLite |
| 长期记忆 | SQLite + 向量检索（后续版本） |

## 10. IPC 接口（渲染进程 ↔ 主进程）

通过 contextBridge 暴露类型安全的 API：

```ts
window.deepwork = {
  chat: {
    send(threadId: string, text: string): void,        // 发起一轮
    cancel(threadId: string): void,
    onEvent(cb: (e: DeepWorkEvent) => void): () => void, // 订阅流式事件
  },
  sessions: { list(), create(), rename(), delete() },
  approval: { respond(requestId, decision): void },     // 响应对话框
  plugins: { list(), add(), remove(), enableTool() },
  settings: { get(), update() },
};
```

事件类型（DeepWorkEvent）：

- `message_delta`（模型文本增量）
- `reasoning_delta`（思考增量）
- `tool_call_started`（id、name、参数摘要）
- `tool_call_finished`（id、输出摘要、产物）
- `approval_requested`（id、工具名、参数、可选编辑）
- `turn_completed` / `turn_error`

## 11. 项目结构（计划）

```
DeepWork/
├── package.json
├── pnpm-workspace.yaml
├── electron.vite.config.ts
├── src/
│   ├── main/                    # Electron 主进程
│   │   ├── index.ts             # app 生命周期、窗口
│   │   ├── agent/               # 内核装配、事件映射
│   │   ├── tools/               # 内置工具 + GUI 工具
│   │   │   ├── builtin/
│   │   │   └── gui/
│   │   ├── mcp/                 # MCP client / server 管理
│   │   ├── ipc/                 # IPC handler 注册
│   │   ├── storage/             # SQLite、配置、密钥
│   │   ├── security/            # 权限策略、审批、审计
│   │   └── services/            # 会话、插件、设置
│   ├── preload/                 # contextBridge
│   └── renderer/                # React UI
│       ├── components/
│       ├── pages/
│       └── stores/
├── resources/                   # 图标等
└── docs/
    └── plans/
```

## 12. v0.0.1 MVP 范围

**做：**

- Electron 常驻窗口，基础聊天界面（发送、流式显示、历史会话列表）
- 内核跑通：deepagents + LangGraph，本地 SQLite checkpoint
- 至少一个云模型（Anthropic 或 OpenAI）+ Ollama 本地模型可选
- 内置工具：文件读写、shell（受限目录）
- GUI 兜底：截屏 + 鼠标点击/键盘输入（nut.js），每次执行前审批
- MCP client：能在设置里添加一个 stdio MCP server 并使用其工具
- 高风险工具审批弹窗（允许/拒绝）
- 基础设置页（模型选择、API key、MCP server 配置）

**不做（留到后续版本）：**

- 无障碍元素树（先用截屏坐标）
- 多 provider fallback / mid-session 切换
- 插件市场
- 长期记忆 / RAG
- OS 级沙箱
- 浏览器自动化（作为后续 MCP 插件接入）
- 全局快捷键呼出、托盘高级功能、定时任务/主动 Agent

## 13. 参考项目结论

我们调研了四个开源项目，结论如下：

- **OpenWorker**（Python/Tauri 桌面）：Agent 循环、Risk×Mode 权限模型、ProviderRouter、MCP 一等公民、Tauri sidecar 打包都值得借鉴。无系统级 GUI 操作。
- **Yuxi**（Python/Vue Web 平台）：Skills 渐进式加载、MCP 配置哈希缓存、中间件分层、上下文压缩设计优秀；但多租户 + 重基础设施（PG/Redis/Milvus）不适合单机桌面。
- **ZeroClaw**（Rust agent runtime）：trait 分层与 `turn_streamed` 事件/取消/审批 API 设计优秀；但 `publish=false`、巨型 monolith、自己的桌面 App 都走进程外，且无键鼠/无障碍能力，不适合整体作为引擎。
- **deepagentsjs**（LangChain 官方 TS 库）：被选为内核基础。纯 npm 库、MIT、流式 + checkpoint + HITL 中断恢复 + 中间件齐全，与 Electron 单进程 + TS 技术栈高度契合；MCP client 需外接 `@langchain/mcp-adapters`，权限风险分级需自己实现。

最终选型吸收了各家之长：用 deepagentsjs 拿到成熟的循环/审批/持久化，借鉴 OpenWorker 的权限分级和 ZeroClaw 的事件 API 形态，GUI 兜底和 MCP 管理自行实现作为差异化。
