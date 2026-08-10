# DeepWork Memory Design

## Status

Implemented baseline, August 2026. DeepWork is local-first: durable memory is
stored in the local SQLite database and Markdown files under `~/DeepWork/memory`.
No vector database, graph database, or external memory service is required.

## Memory stores and responsibilities

| Store | Purpose | Writer | Reader |
| --- | --- | --- | --- |
| User profile (`user_memory.md`) | Curated personal background, preferences, and recent updates | User and `remember` | Every turn |
| SQLite memories | Bounded semantic/keyword retrieval of workspace and global facts | Memory UI, extraction pipeline | Every turn and memory tools |
| Timeline memory | Daily distilled work events | Post-turn timeline capture | Memory settings UI |
| Project memory | Project-specific decisions and work history, grouped by date | Post-turn timeline capture | Every turn in that project and memory settings UI |
| LangGraph checkpoint | Full conversation and tool history | Agent runtime | Session history and regeneration |

The stores intentionally have different lifecycles. The user profile is a
human-curated source of truth; checkpoints are raw conversation history;
structured memories are retrieval indexes; timeline and project files are
readable work journals.

## Structured memory model

The `memories` SQLite table stores:

- `id`, `content`, `created_at`
- `scope` and `scope_key` (`global` or `workspace`)
- `type` (`preference`, `fact`, or `event`)
- `importance`
- `status` (`active` or `invalid`)
- `source`, such as `session:<id>:turn:<n>`
- Optional embedding bytes

Invalidation is soft: superseded entries are marked `invalid`, not silently
deleted. Explicit user deletion removes the record.

## Retrieval and context injection

For every model call, context middleware builds a non-persisted system message:

1. Full user profile Markdown.
2. The Top-K relevant SQLite memories for the active session workspace.
3. Project memory when the active session is attached to a real project folder.
4. Plan-mode restrictions and project instruction files (`AGENTS.md`,
   `CLAUDE.md`, and `CLAUDE.local.md`).

Semantic retrieval uses configured embeddings when available. If embeddings are
disabled or unavailable, it falls back to bounded Unicode-aware keyword scoring.
Each injected SQLite memory includes its ID, type, and source. This lets the
model and future UI surfaces explain why a fact was present in context without
claiming that a retrieved item is authoritative.

Project memory is capped to its newest 12,000 characters during injection. It
is stored as readable Markdown, newest date first, and is written only for a
real selected project—not the default scratch workspace.

## Automatic extraction

After a successful user turn, optional AUDN-style extraction asks the configured
chat model for concise durable facts. Candidate facts are deduplicated against
active workspace memories before being added. The user message is explicitly
treated as untrusted data in the extraction prompt. Extraction never blocks a
chat response, and failures leave the turn successful.

Timeline capture runs independently after a successful turn. It stores concise
daily points and mirrors them to project memory for real project sessions.

## User controls

Users can inspect, edit, remove, and search structured memories in Settings.
They can edit the user profile Markdown directly and browse timeline/project
memory files. Automatic extraction, embedding provider/model, Top-K, and the
similarity threshold are configurable in Settings.

## Boundaries and future work

Current retrieval is intentionally simple for personal-scale data. Future work
may add explicit review queues for extracted memories, hybrid lexical reranking,
and a separate archival tier. A graph backend is not part of the current
architecture and must not be assumed by callers.
