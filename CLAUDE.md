# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Feishu Claude Code Bridge — a TypeScript/Node.js server that bridges Feishu (Lark) messaging with Anthropic's Claude Code via the Agent SDK. Users send messages in Feishu chats, and the server executes Claude Code queries against a working directory on the host machine.

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
- **`src/server.ts`** — Express server with dual event mode: WebSocket (default, no public IP needed) or HTTP webhook.
- **`src/feishu/client.ts`** — Feishu API wrapper using `@larksuiteoapi/node-sdk` for sending/updating messages and cards.
- **`src/feishu/event-handler.ts`** — EventDispatcher handlers for incoming messages and card actions. Orchestrates the full flow: parse message → check allowlist → get/create session → enqueue task → execute → send result.
- **`src/feishu/message-builder.ts`** — Constructs interactive Feishu card messages for progress and results.
- **`src/claude/executor.ts`** — Wraps `@anthropic-ai/claude-agent-sdk` `query()`. Streams SDKMessage async generator, extracts output text, tracks cost/duration. Supports session resumption via `resumeSessionId`. Uses `permissionMode: 'acceptEdits'` + `canUseTool` auto-allow (not `bypassPermissions` which fails under root). Budget: configurable via `CLAUDE_MAX_BUDGET_USD` (default $50) and `CLAUDE_MAX_TURNS` (default 500). Injects MCP workspace tool via `createSdkMcpServer`.
- **`src/workspace/tool.ts`** — MCP tool `setup_workspace` for creating isolated workspaces. Each query gets its own MCP server instance via closure to avoid concurrency issues.
- **`src/workspace/manager.ts`** — Git clone + workspace isolation. Supports remote URL (via bare cache) and local path modes. URL normalization handles SSH shorthand.
- **`src/workspace/cache.ts`** — Bare clone cache layer for fast repeated clones.
- **`src/pipeline/orchestrator.ts`** — State-machine-driven multi-step dev pipeline (plan → review → implement → review → push). Uses parallel multi-agent review.
- **`src/pipeline/reviewer.ts`** — Parallel review with 3 agents (correctness/security/architecture).
- **`src/session/manager.ts`** — In-memory session store keyed by `chatId:userId`. Maps each chat to a working directory. Auto-cleans sessions idle >2 hours.
- **`src/session/queue.ts`** — Per-chat FIFO task queue ensuring one Claude query runs at a time per chat.
- **`src/utils/security.ts`** — User allowlist check and dangerous command regex detection (`rm -rf /`, `mkfs`, `dd if=`, etc.).
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

Environment variables loaded via dotenv (see `.env.example`):

- **Required**: `FEISHU_APP_ID`, `FEISHU_APP_SECRET`
- **Claude**: `ANTHROPIC_API_KEY`, `DEFAULT_WORK_DIR` (default: `/home/ubuntu/projects`), `CLAUDE_TIMEOUT` (default: 300s), `CLAUDE_MAX_TURNS` (default: 500), `CLAUDE_MAX_BUDGET_USD` (default: 50)
- **Workspace**: `REPO_CACHE_DIR` (bare clone cache), `WORKSPACE_BASE_DIR` (writable workspaces), `WORKSPACE_BRANCH_PREFIX`
- **Event mode**: `FEISHU_EVENT_MODE` (`websocket` | `webhook`), `FEISHU_ENCRYPT_KEY`, `FEISHU_VERIFY_TOKEN` (webhook only)
- **Security**: `ALLOWED_USER_IDS` (comma-separated, empty = allow all)
- **Server**: `PORT` (default: 3000), `NODE_ENV`, `LOG_LEVEL`

## Testing Policy

- **新功能必须附带单元测试** — 新增的模块/函数需要在 `tests/` 下有对应的 `.test.ts` 文件。
- **Bug fix 需附带回归测试** — 修复的 bug 应有测试用例覆盖，防止回归。
- **复杂改动须通过完整回归** — 涉及多模块或核心逻辑的改动，提交前需运行 `npx vitest run` 确保全部测试通过。
- **PR 不得降低测试覆盖率** — 新增代码应有合理的测试覆盖，不允许只加功能不加测试。

## Deployment

- PR 合并到 main 后会自动触发 GitHub Actions deploy workflow，将代码部署到服务器并自动 `pm2 restart`。
- **严禁在对话中执行 `pm2 restart feishu-claude`** — Claude 作为 bridge server 的子进程运行，执行此命令会杀掉自己的父进程，导致级联重启。

## Tech Stack

- TypeScript 5.7, Node.js 18+, Express 4
- `@anthropic-ai/claude-agent-sdk` for Claude Code execution
- `@larksuiteoapi/node-sdk` for Feishu API + WebSocket events
- Pino for structured logging, Zod available for validation
