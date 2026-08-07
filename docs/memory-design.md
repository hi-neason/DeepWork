# DeepWork 记忆模块设计文档

> 状态：设计阶段（A 起步，B/C 可插拔）
> 关联：用户指令「做桌面本地个人助手的记忆模块」，经业界调研 + 竞品分析后定稿
> 日期：2026-08-07

---

## 1. 背景与目标

DeepWork 是 local-first 桌面 AI Agent。现状记忆能力仅为一个**纯文本 KV**：`memories` 表（`id/content/scope/scope_key/created_at`）+ 三个工具 `remember/forget/list_memories`，由 `context` 中间件**每轮全量注入** system prompt。

问题：
- 记忆一多就爆 context（全量注入，无检索）
- 无自动抽取（靠 agent 主动调 `remember`，经常漏记）
- 无分类 / 重要性 / 时间失效 / 冲突消解 / 来源追溯

目标：把记忆从「KV 便签」升级为「**可检索、可自动沉淀、可演进的长期记忆**」，同时保持 local-first、零外部依赖、透明可控。

---

## 2. 业界调研摘要

### 2.1 记忆范式
- **认知三分**（arXiv 2512.13564）：Factual / Experiential / Working。RAG 只解 Factual，Experiential 必须显式写下来。
- **MemGPT/Letta 三层级**（OS 隐喻）：Core（常驻 prompt）/ Recall（可检索历史）/ Archival（冷存储），Agent 自管 paging。
- **Generative Agents**：Memory Stream + Reflection（低层经历反思成高层事实）。
- **2026 三大学派**：Graph-based（Mem0/Zep）、OS-inspired（Letta）、Observational（Mastra，全压 context）。

### 2.2 竞品对比
| 产品 | 形态 | 要点 | 隐私 |
|---|---|---|---|
| Claude Code | `CLAUDE.md` 4 层 | `#`加 `/memory`看 `@`导入 `/compact`压 | 本地 MD，无黑盒 |
| Cursor | `.cursorrules` | 静态注入 | 本地 |
| ChatGPT | 显式+隐式 | 用户档案，可删 | 云端可控 |
| Mem0 | 抽取+向量+图 | **AUDN** 冲突消解，压缩 93% | 可自托管 |
| Zep/Graphiti | 时间知识图 | bi-temporal，矛盾只「失效」不删 | 需图库 |
| Letta | Agent 自管块 | git-backed，local-LLM 友好 | 本地 |
| OpenClaw | 本地优先 | `fs.watch`→reindex→**sqlite-vec**→QMD 三阶段检索 | 不出本机 |

> 重点参考 **OpenClaw**：与 DeepWork 同构（Electron+SQLite），其 `fs.watch → chunk(512tok) → on-device embedding → sqlite-vec/LanceDB → 向量ANN + BM25 重排` 是桌面助手可直接借鉴的范式。

### 2.3 最新架构共识
1. 抽取式结构化记忆（AUDN：Add/Update/Delete/Noop，冲突消解交给 LLM）
2. 图 + 时间（Graphiti，四时间戳，多跳推理）
3. 层级上下文（Core 零延迟 + 按需检索）
4. 反思/压缩（Generative Agents + `/compact`）
5. 混合架构（VentureBeat 预测年末专用记忆层超 RAG）
6. 本地优先关键件：on-device embedding（nomic-embed-text/bge-small）、sqlite-vec、BM25 rerank、增量 reindex

---

## 3. 设计原则

1. **本地优先**：数据不出本机，默认后端用 SQLite + 本地向量扩展。
2. **可插拔**：通过 `MemoryBackend` 抽象层，A（向量）/B（图）/C（分层）可切换。
3. **透明可控**：记忆可被用户查看/编辑/删除；抽取可关；不黑盒。
4. **最小摩擦**：A 阶段零新增外部服务（不引入图库/独立向量服务）。

---

## 4. 总体架构

```
          对话事件 ──▶ 抽取管线(AUDN) ──▶ MemoryBackend.add/update/delete
                                              │
  每轮 prompt 构建 ◀── 检索管线(Top-K+rerank) ◀── MemoryBackend.search
                                              │
            ┌─────────────────┼─────────────────┬─────────────────┐
      SQLite + sqlite-vec      Graphiti 时间图         分层 (core/recall/archival)
        (Backend A 默认)         (Backend B 可选)         (Backend C 可选)
```

`settings.memory.backend` 选择实现；上层只依赖接口。

### 4.1 MemoryBackend 接口（草案）
```ts
interface MemoryEntry {
  id: string;
  content: string;
  scope: string;       // user | workspace | project
  scopeKey: string;
  type: "preference" | "fact" | "event";
  importance: number;  // 0~1
  status: "active" | "invalid";
  createdAt: number;
  invalidAt?: number;
  source?: string;     // waypoint: sessionId/turn
  embedding?: Float32Array;
  metadata?: Record<string, unknown>;
}

interface MemorySearchOpts {
  scope?: string;
  scopeKey?: string;
  type?: MemoryEntry["type"];
  topK?: number;
  threshold?: number; // 相似度下限
}

interface MemoryBackend {
  add(content: string, meta: Partial<MemoryEntry>): MemoryEntry;
  update(id: string, patch: Partial<MemoryEntry>): void;
  invalidate(id: string, at?: number): void;   // 时间失效，不物理删
  delete(id: string): void;
  search(query: string, opts?: MemorySearchOpts): MemoryEntry[];
  list(opts?: MemorySearchOpts): MemoryEntry[];
}
```

### 4.2 默认后端 A：SQLite + sqlite-vec
- `db.loadExtension('sqlite-vec')`，向量存 BLOB 列，Exact KNN（百~千条记忆足够，亚毫秒）。
- embedding 用 on-device 模型（Ollama `nomic-embed-text` 或现有 provider 的 embed 能力）。

### 4.3 可选后端（后续插拔）
- **B 时间图**：映射到图节点+边+四时间戳，复用 `status/invalidAt` 字段语义。
- **C 分层**：在 Backend 上叠加 Core（常驻 Top-N 高 importance）/ Recall / Archival 路由。

---

## 5. 数据模型

`memories` 表扩展（迁移加列，旧数据默认 `type=fact, status=active, importance=0.5`）：
```sql
ALTER TABLE memories ADD COLUMN embedding  BLOB;     -- sqlite-vec 向量
ALTER TABLE memories ADD COLUMN type       TEXT NOT NULL DEFAULT 'fact';
ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.5;
ALTER TABLE memories ADD COLUMN status     TEXT NOT NULL DEFAULT 'active';
ALTER TABLE memories ADD COLUMN invalid_at INTEGER;
ALTER TABLE memories ADD COLUMN source     TEXT;
ALTER TABLE memories ADD COLUMN metadata   TEXT;     -- JSON
```
保留：`id/content/scope/scope_key/created_at`。

---

## 6. 抽取管线（AUDN）

- **触发**：`manager.runTurn` 收尾，异步跑（不阻塞回复）。
- **步骤**：
  1. 取本轮对话文本 → 调 embedding 得 query vector。
  2. `backend.search(query, {topK: S})` 取最相似 S 条已有记忆。
  3. 连同新事实交给抽取 LLM（可用小模型本地跑省成本）判定：
     - **Add**：全新信息 → `backend.add`
     - **Update**：补充已有 → `backend.update`
     - **Delete**：被新事实推翻 → `backend.invalidate`（保留历史）
     - **Noop**：已覆盖 → 跳过
- **开关**：`settings.memory.autoExtract`（默认开）；关闭则退回手动 `remember`。

---

## 7. 检索与注入

- `context` 中间件改为**检索注入**：每轮用「当前用户输入 + 最近 N 轮」作 query →
  `backend.search(query, {scope, topK:10, threshold:0.6})` → Top-K 拼 system prompt。
- 替换现有「全量 `listMemories` 注入」。
- 可选增强（V1）：向量召回 + BM25 关键词重排（QMD 三阶段）。

---

## 8. 工具集（Agent 接口）

保留 `remember` / `forget`；扩展：
| 工具 | 作用 |
|---|---|
| `remember` | 手动存（兼容现有） |
| `forget` | 按 id 删 |
| `search_memories(query, topK?)` | agent 主动语义检索（替全量 list） |
| `edit_memory(id, content)` | 修正（原 forget+remember 合一） |
| `list_memories(scope?, type?)` | 带过滤的列举（UI/debug 用） |

---

## 9. 与现有代码衔接

| 文件 | 改动 |
|---|---|
| `storage/db.ts` | migrate 加列；`db.loadExtension('sqlite-vec')` |
| `storage/memories.ts` | 新增 `searchMemories/upsertMemory/invalidateMemory`，封装 `MemoryBackend` |
| `agent/context.ts` | 全量注入 → 检索注入 |
| `agent/manager.ts` | `runTurn` 收尾挂抽取任务（异步） |
| `tools/memory.ts` | 扩展工具集（search/edit） |
| `components/RightPanel.tsx` | 新增「记忆」Tab（展示/编辑/删除） |

---

## 10. MVP 任务拆解（A 阶段）

1. 依赖：`sqlite-vec` 加入；`db.ts` migrate 加列 + `loadExtension`。
2. `MemoryBackend` 接口 + `SqliteVecBackend` 实现（add/search + embedding）。
3. embedding 模型接入（on-device：Ollama `nomic-embed-text` 或 provider embed）。
4. `context.ts` 改为检索注入（取代全量）。
5. 抽取管线 AUDN（后台任务 + `settings.memory.autoExtract` 开关）。
6. `memory.ts` 工具扩展（search/edit）。
7. RightPanel 记忆 Tab UI。
8. `pnpm typecheck` + `pnpm build` + 手动验证（记忆跨会话可检索、自动沉淀、可编辑）。

---

## 11. 后续演进（B/C 插拔）

- **V1**：冲突消解打磨 + 时间失效 UI + BM25 重排。
- **V2（可选 B）**：Graphiti 式时间图后端，支持多跳「什么导致这个决定」。
- **V2（可选 C）**：Letta 式分层，Core 常驻 + Recall/Archival 路由。

---

## 12. 风险与权衡

- **抽取成本**：每轮 LLM 调用。缓解：小模型本地跑 + 节流（仅对话结束/关键点抽取）。
- **embedding 质量**：本地小模型弱于云端。缓解：可选用现有 provider embed；阈值可调。
- **误抽/误忘**：AUDN 由 LLM 判定，可能错。缓解：UI 可审阅/修正；`autoExtract` 可关。
- **向量库选型**：sqlite-vec Exact KNN 适合个人量级；量级到万级再切 LanceDB（抽象层已预留）。
