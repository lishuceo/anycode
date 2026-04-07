# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Anycode — a multi-agent development system with Feishu (Lark) as collaboration UI, powered by Anthropic's Claude Code via the Agent SDK. Users send messages in Feishu chats, and the server executes Claude Code queries against a working directory on the host machine.

## Commands

```bash
npm run dev          # Start dev server with auto-reload (tsx watch)
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled JS from dist/
npm run typecheck    # Type-check without emitting
npm run lint         # ESLint on src/
```

```bash
npx vitest run        # Run all tests (vitest)
```

## Architecture

### Event Flow

```
Feishu User → Feishu Platform → Bridge Server → Claude Agent SDK → Claude Code subprocess
                                     ↑
                              Progress cards + result cards sent back to Feishu
```

### Key Modules

- **`src/index.ts`** — Entry point: validates config, starts server, sets up 30-min cleanup interval and graceful shutdown (SIGINT/SIGTERM).
- **`src/config.ts`** — Environment-based configuration loader. Exports single config object with Feishu, Claude, workspace, memory, cron settings.
- **`src/server.ts`** — Express server with dual event mode: WebSocket (default, no public IP needed) or HTTP webhook.
- **`src/agent/`** — Multi-agent role system. `registry.ts` stores agent configs at runtime; `router.ts` routes messages to agents by chat binding rules; `config-loader.ts` loads agent configs from JSON (`config/agents.json`) with hot-reload.
- **`src/claude/executor.ts`** — Wraps `@anthropic-ai/claude-agent-sdk` `query()`. Streams SDKMessage, tracks cost/duration, supports session resumption and workspace restart with conversation trace forwarding. Budget: `CLAUDE_MAX_BUDGET_USD` (default $50), `CLAUDE_MAX_TURNS` (default 500).
- **`src/feishu/client.ts`** — Feishu API wrapper for sending/updating messages and cards.
- **`src/feishu/event-handler.ts`** — EventDispatcher: parse message → check allowlist → get/create session → enqueue task → execute → send result.
- **`src/feishu/message-builder.ts`** — Constructs interactive Feishu card messages for progress and results.
- **`src/feishu/thread-context.ts`** — Unified thread/workspace context resolution before execution. Defaults to `DEFAULT_WORK_DIR`; main agent uses `setup_workspace` MCP tool to switch repos during execution.
- **`src/feishu/bot-registry.ts`** — Tracks bot members in group chats; auto-discovers via events and message senders.
- **`src/feishu/tools/`** — MCP tool suite: `doc.ts`(文档), `wiki.ts`(知识库), `bitable.ts`(多维表格), `drive.ts`(云空间), `chat.ts`, `calendar.ts`, `contact.ts`, `task.ts`. Action-based dispatch with Zod schemas.
- **`src/workspace/manager.ts`** — Git clone + workspace isolation. Supports remote URL (via bare cache) and local path modes.
- **`src/workspace/cache.ts`** — Bare clone cache layer with atomic creation and configurable fetch interval.
- **`src/workspace/registry.ts`** — Repo registry system. Scans DEFAULT_WORK_DIR + .repo-cache, maintains JSON index (`.repo-registry.json`) with canonical URL keys, generates Markdown for LLM reading. Caches source repo paths for `isInsideSourceRepo()`.
- **`src/workspace/isolation.ts`** — Per-thread workspace isolation + source repo protection. `isInsideSourceRepo()` blocks writes to DEFAULT_WORK_DIR source repos via `canUseTool`.
- **`src/pipeline/orchestrator.ts`** — State-machine-driven dev pipeline (plan → plan_review → implement → code_review → push → pr_fixup). Max 2 retries per phase.
- **`src/pipeline/reviewer.ts`** — Parallel review with 3 agents (correctness/security/architecture) + optional Codex reviewer.
- **`src/session/manager.ts`** — SQLite-backed session store keyed by `agent:{agentId}:{chatId}:{userId}`. Thread-level sessions bind threadId → workdir/conversationId.
- **`src/session/database.ts`** — SQLite persistence with 13 migrations. Stores sessions, thread sessions, summaries, and OAuth tokens.
- **`src/session/queue.ts`** — Per-chat FIFO task queue ensuring one Claude query runs at a time per chat.
- **`src/memory/`** — Long-term memory system. `store.ts`(SQLite + sqlite-vec CRUD), `search.ts`(hybrid BM25 + vector), `extractor.ts`(LLM auto-extraction), `injector.ts`(prompt injection), `commands.ts`(/memory slash commands).
- **`src/cron/`** — Scheduled task system. `scheduler.ts`(cron/interval/at scheduling with retry), `store.ts`(SQLite persistence), `tool.ts`(MCP tool for agent interaction).
- **`src/platform/types.ts`** — Platform-agnostic message interfaces (MessagePort, InboundMessage).
- **`src/utils/security.ts`** — User allowlist check and dangerous command regex detection.
- **`src/utils/logger.ts`** — Pino logger singleton.

### Key Patterns

- **ESM throughout** — `"type": "module"` in package.json, ES2022 target, `.js` extensions in imports.
- **Singleton instances** — `sessionManager`, `claudeExecutor`, `taskQueue`, `feishuClient`, `logger` are module-level singletons.
- **Two-phase messaging** — Send a progress card first, then update it with the final result card.
- **Session isolation** — Each Feishu chat gets its own working directory and serialized task queue.

### Agent SDK Gotchas

- **`canUseTool` must return `updatedInput`** — `{ behavior: 'allow' }` alone causes SDK internal Zod validation failure. MCP tool handlers silently won't execute. Must return `{ behavior: 'allow', updatedInput: inputObj }`.
- **`bypassPermissions` fails under root** — Use `permissionMode: 'acceptEdits'` + `canUseTool` callback instead.
- **`settingSources: ['project']`** loads `.claude/settings.local.json` from cwd, including `permissions.allow` whitelist. This whitelist is checked *before* `canUseTool`, so unlisted tools (including MCP) get blocked. Currently `canUseTool` with proper `updatedInput` overrides this.
- **Skills require `allowedTools: ['Skill']`** — SDK 默认不启用 Skill 工具。仅有 `settingSources: ['project']` 不够，还需在 `allowedTools` 中显式包含 `'Skill'`，否则 `.claude/skills/` 中的 SKILL.md 不会被加载。
- **Feishu rich text breaks URLs** — `github.com:user/repo` gets auto-linked by Feishu as `[github.com:](http://github.com/)user/repo`. The `workspace/manager.ts` `normalizeRepoUrl()` handles SSH shorthand normalization.

## Configuration

### Agent Config (`config/`)

Agent definitions, knowledge files, and persona prompts live in `config/` but are **not checked into git** (deployment-specific). Only `config/agents.example.json` is tracked as a structural reference.

First-time setup: `cp config/agents.example.json config/agents.json` then customize. Without `config/agents.json`, the system falls back to a minimal built-in dev agent.

### Environment Variables

Loaded via dotenv (see `.env.example`):

- **Required**: `FEISHU_APP_ID`, `FEISHU_APP_SECRET`
- **Claude**: `ANTHROPIC_API_KEY`, `DEFAULT_WORK_DIR` (default: parent of cwd), `CLAUDE_TIMEOUT` (default: 300s), `CLAUDE_MAX_TURNS` (default: 500), `CLAUDE_MAX_BUDGET_USD` (default: 50)
- **Workspace**: `REPO_CACHE_DIR` (bare clone cache), `WORKSPACE_BASE_DIR` (writable workspaces), `WORKSPACE_BRANCH_PREFIX`
- **Event mode**: `FEISHU_EVENT_MODE` (`websocket` | `webhook`), `FEISHU_ENCRYPT_KEY`, `FEISHU_VERIFY_TOKEN` (webhook only)
- **Memory**: `MEMORY_ENABLED`, `DASHSCOPE_API_KEY`, `MEMORY_DB_PATH` (default: `./data/memories.db`), `MEMORY_EMBEDDING_MODEL`, `MEMORY_VECTOR_WEIGHT`
- **Cron**: `CRON_DB_PATH` (default: `./data/cron.db`)
- **Security**: `ALLOWED_USER_IDS` (comma-separated, empty = allow all)
- **Server**: `PORT` (default: 3000), `NODE_ENV`, `LOG_LEVEL`

## Testing Policy

- **新功能必须附带单元测试** — 新增的模块/函数需要在 `tests/` 下有对应的 `.test.ts` 文件。每个 feat commit 必须伴随对应的 test commit。
- **Bug fix 需附带回归测试** — 修复的 bug 应有测试用例覆盖，防止回归。
- **复杂改动须通过完整回归** — 涉及多模块或核心逻辑的改动，提交前需运行 `npx vitest run` 确保全部测试通过。
- **PR 不得降低测试覆盖率** — 新增代码应有合理的测试覆盖，不允许只加功能不加测试。

## Deployment

- PR 合并到 main 后会自动触发 GitHub Actions deploy workflow，将代码部署到服务器并自动 `pm2 restart`。
- **严禁在对话中执行 `pm2 restart anycode`** — Claude 作为服务的子进程运行，执行此命令会杀掉自己的父进程，导致级联重启。

## Tech Stack

- TypeScript 5.7, Node.js 18+, Express 4
- `@anthropic-ai/claude-agent-sdk` for Claude Code execution
- `@larksuiteoapi/node-sdk` for Feishu API + WebSocket events
- Pino for structured logging, Zod available for validation

## 项目文档

文档按生命周期分三个目录：

| 目录 | 内容 | 生命周期 |
|------|------|----------|
| `docs/plans/` | 活跃的实施计划 | 短期，完成后蒸馏关键决策到 `design/`，再删除 |
| `docs/design/` | 模块架构与设计决策（描述**现状**） | 长期保留，随代码持续更新 |
| `docs/research/` | 调研分析 | 只读参考 |

### Agent 工作流

- **开始新任务前**，扫描 `docs/plans/*.md` 的 YAML front matter，读取 `summary` 和 `read_when` 字段，判断是否与当前任务相关。如果相关，先读完该计划再动手。
- 也可以运行 `node scripts/docs-list.mjs` 快速查看所有活跃计划的列表（支持 `--status in_progress` 过滤和 `--json` 输出）。
- **修改代码时**，检查 `docs/design/*.md` 的 `related_paths` 字段。如果当前修改涉及某文档的关联路径，阅读该文档，若描述与代码现状不符则一并更新（将提案口吻改写为现状描述）。
- **Plan 完成时**，将关键设计决策和架构信息蒸馏到 `docs/design/` 对应文档，然后删除 plan 文件。
- **新建计划文件**时，必须包含以下 front matter：

```yaml
---
summary: "一句话描述"
status: draft              # draft | in_progress | completed
owner: git-id
last_updated: "YYYY-MM-DD"
read_when:
  - 触发场景 1
  - 触发场景 2
---
```

- **Design 文档**也使用 front matter，格式：

```yaml
---
summary: "一句话描述"
related_paths:
  - src/module/**
last_updated: "YYYY-MM-DD"
---
```
