# Anycode

Multi-agent development system with Feishu (Lark) as collaboration UI, powered by Claude's [Agent SDK](https://docs.anthropic.com/en/docs/agent-sdk/overview).

Deploy once, serve your entire team. Everyone talks to the same bot in Feishu — each conversation automatically gets an isolated workspace, so multiple people can work on the same repo concurrently without stepping on each other.

## Why Anycode

- **Team-wide, single deployment** — One server handles all users. No per-person setup, no seat management. Add someone to the Feishu group and they're ready to go.
- **True workspace isolation via bare clone cache** — Each conversation gets its own full clone from a shared bare cache. Unlike worktree-based solutions, there's no branch locking — ten people can all work on `main` simultaneously, each in a completely independent workspace. New workspaces are created from local cache in seconds, not re-cloned from remote.
- **Multi-agent collaboration** — Multiple agents with different roles coexist in the same group chat. A read-only chat assistant and a full-access dev bot can work side by side, each with its own model, permissions, and persona.

## Features

- **Multi-agent architecture** — Define agents with different models, permissions, and personas in a single config file
- **Multi-bot routing** — Each agent binds to its own Feishu bot app; messages are routed automatically
- **Bare clone workspace isolation** — Each conversation gets an independent clone from a shared bare cache; source repos are write-protected
- **Session management** — SQLite-backed sessions with conversation resumption across restarts
- **Interactive cards** — Real-time progress cards in Feishu, updated as Claude works
- **Feishu tools (MCP)** — Agents can read/write Feishu docs, wikis, bitables, calendars, tasks, and contacts
- **Memory system** — Long-term memory with hybrid BM25 + vector search, auto-extraction from conversations
- **Scheduled tasks** — Cron/interval/at scheduling with retry, managed via MCP tool
- **Dev pipeline** — State-machine pipeline: plan → review → implement → code review → push → PR fixup
- **Owner approval** — Non-owner users require approval before code-editing operations
- **Self-update** — The bot can pull code and restart itself when asked (runtime auto-detected)

## Architecture

```
Feishu User → Feishu Platform → Bridge Server → Claude Agent SDK → Claude Code subprocess
                                      ↑
                               Progress cards + result cards sent back to Feishu
```

### Key Modules

| Module | Description |
|--------|-------------|
| `src/agent/` | Multi-agent role system: config loading, routing, registry |
| `src/claude/executor.ts` | Wraps Agent SDK `query()`, streams messages, tracks cost |
| `src/feishu/` | Feishu client, event handling, message cards, OAuth |
| `src/feishu/tools/` | MCP tool suite: doc, wiki, bitable, drive, calendar, task, contact |
| `src/workspace/` | Git clone + workspace isolation, bare clone cache, repo registry |
| `src/session/` | SQLite session store, per-chat task queue |
| `src/memory/` | Long-term memory: store, hybrid search, LLM extraction, prompt injection |
| `src/cron/` | Scheduled tasks: cron/interval/at scheduling with SQLite persistence |
| `src/pipeline/` | Dev pipeline orchestrator + parallel 3-agent code review |

## Quick Start

### Prerequisites

- Node.js 18+
- A Feishu (Lark) app with bot capability enabled ([create one here](https://open.feishu.cn/app))
- An Anthropic API key ([get one here](https://console.anthropic.com/))

### 1. Clone and install

```bash
git clone https://github.com/anthropics/anycode.git
cd anycode
npm install
```

### 2. Configure

```bash
# Copy example configs
cp .env.example .env
cp config/agents.example.json config/agents.json
```

Edit `config/agents.json` — fill in your Feishu app credentials (`appId`, `appSecret`) and customize agent settings.

Edit `.env` — set your `ANTHROPIC_API_KEY` and other options. See `.env.example` for all available settings.

Or run the interactive onboarding wizard:

```bash
npm run onboard
```

### 3. Feishu app setup

In the [Feishu Developer Console](https://open.feishu.cn/app):

1. **Enable bot capability** — Add the "Bot" feature to your app
2. **Add permissions** — `im:message:send_as_bot`, `im:message:update`, and at least one receive permission (`im:message.p2p_msg:readonly` or `im:message.group_at_msg:readonly`)
3. **Enable event subscription** — Select "Long connection (WebSocket)" mode, add `im.message.receive_v1` event
4. **Publish the app** — Create a version and submit for review

### 4. Start

```bash
# Development (auto-reload)
npm run dev

# Production
npm run build
npm start
```

You should see `Feishu WebSocket connected` — no public IP or domain needed.

### 5. Deploy (optional)

```bash
# Using PM2
npm install -g pm2
npm run build
pm2 start ecosystem.config.cjs

# Or systemd, Docker, etc. — the server auto-detects its process manager
```

## Agent Configuration

Agents are defined in `config/agents.json`. Each agent has its own Feishu bot, model, permissions, and persona.

See `config/agents.example.json` for the full schema. Key fields:

```jsonc
{
  "agents": [
    {
      "id": "assistant",
      "displayName": "Assistant Bot",
      "description": "Chat bot — readonly, direct reply",
      "feishu": { "appId": "cli_xxx", "appSecret": "xxx" },
      "model": "claude-sonnet-4-6",
      "toolPolicy": "readonly",
      "replyMode": "direct",       // reply in-place
      "persona": "./personas/assistant.md",
      "knowledge": ["team.md"]
    },
    {
      "id": "dev",
      "displayName": "Dev Bot",
      "description": "Dev bot — full read/write, creates threads",
      "feishu": { "appId": "cli_xxx", "appSecret": "xxx" },
      "model": "claude-opus-4-6",
      "toolPolicy": "all",
      "replyMode": "thread",       // create a thread per message
      "requiresApproval": true      // non-owner needs approval
    }
  ]
}
```

## Environment Variables

All options are documented in `.env.example`. Key ones:

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `FEISHU_EVENT_MODE` | No | `websocket` (default) or `webhook` |
| `DEFAULT_WORK_DIR` | No | Root directory for projects (default: parent of cwd) |
| `ALLOWED_USER_IDS` | No | Comma-separated Feishu open_ids (empty = allow all) |
| `OWNER_USER_ID` | No | Admin user with full permissions |
| `MEMORY_ENABLED` | No | Enable long-term memory system |
| `CRON_ENABLED` | No | Enable scheduled tasks |

## Development

```bash
npm run dev          # Start with auto-reload
npm run build        # Compile TypeScript
npm run typecheck    # Type-check without emitting
npm run lint         # ESLint
npx vitest run       # Run all tests
```

## Tech Stack

- TypeScript 5.7, Node.js 18+, Express 4
- [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) for Claude Code execution
- [@larksuiteoapi/node-sdk](https://www.npmjs.com/package/@larksuiteoapi/node-sdk) for Feishu API + WebSocket events
- SQLite (better-sqlite3 + sqlite-vec) for sessions, memory, and scheduled tasks
- Pino for structured logging

## License

[MIT](LICENSE)
