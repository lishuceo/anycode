---
summary: "定时任务调度系统：支持 cron 表达式、一次性定时、固定间隔的 agent 任务调度"
status: draft
owner: lishuceo
last_updated: "2026-03-17"
read_when:
  - 实现定时任务、计划任务、cron 相关功能
  - 需要理解调度系统架构
  - 修改 cron 相关代码
---

# Plan 7: Cron Scheduler — 定时任务调度系统

## 背景

用户希望 agent 能够定时执行任务（日报、巡检、定期代码审查等）。调研了 Claude Code 内置的 `/loop` 和 OpenClaw 的 cron 系统后，确认需要自建方案：

- Claude Code 的 `/loop` 是会话级的，重启即丢失，不适合服务端
- OpenClaw 的方案（JSON 文件 + setTimeout + croner）架构轻量，值得借鉴
- 我们的场景：定时触发 → Claude agent 执行 → 结果发回飞书

## 设计决策

### 存储：SQLite（非 JSON 文件）

OpenClaw 用 JSON 文件存储 jobs，适合单进程桌面应用。我们选择 SQLite：

- 与现有 sessions.db 一致，复用 `better-sqlite3`
- 原子性更强（WAL 模式 vs JSON atomic rename）
- 支持索引查询（按 chatId、nextRunAtMs 等）
- 运行历史天然适合关系表

### 调度：croner + setTimeout

借鉴 OpenClaw 的模式：
- 用 `croner` 解析 cron 表达式（OpenClaw 同款，轻量零依赖）
- setTimeout 驱动（非 setInterval），每次 tick 后重算下次唤醒时间
- 最大 60s 兜底唤醒，防 drift

### 执行：复用 executeClaudeTask()（模拟 @bot）

**核心思路**：cron 触发时，构造合成消息注入现有流程，等价于用户在话题里 @bot。

```
Timer tick → 发占位消息拿 messageId → executeClaudeTask(prompt, chatId, userId, messageId, rootId, threadId)
```

这样做的好处：
- **零新执行路径** — 完全复用 event-handler 现有逻辑
- **上下文免费获得** — workspace、session resume、history summaries 自动生效
- **进度卡片照常** — 用户在话题里看到和平时一模一样的进度更新和结果卡片
- **队列自动排队** — 如果 agent 正忙，cron 任务排到队列后面
- **和 OpenClaw 的 `main` 模式等价** — 区别只是我们不需要 heartbeat 中间层

### 管理方式：MCP 工具（等价于 OpenClaw 的 Gateway RPC）

OpenClaw 的 agent 通过 Gateway Protocol（WebSocket RPC）调用 `cron.add` 等方法管理定时任务，
支持自然语言创建（用户说"每天9点提醒我" → agent 调 `cron.add`）。

我们的 MCP tool 是同一模式的不同实现——Claude Agent SDK 的 agent 通过 MCP 协议调用外部能力：

```
OpenClaw:  用户 → agent → gateway.cron.add()    → jobs.json
我们:      用户 → agent → MCP:manage_cron(add)   → SQLite
```

- 用户通过飞书自然语言交互，agent 理解意图后调用 MCP 工具
- agent 也可以在执行过程中自主创建定时任务（如"每天早上 9 点给我发日报"）
- 同时保留 `/cron list` 等快捷命令（不过 LLM，直接响应）

## 架构

```
创建任务:
  用户飞书消息 "每天9点跑日报"
    → agent 理解意图
    → 调用 MCP tool: manage_cron(action: "add", ...)
    → CronScheduler 写入 DB + armTimer()

执行任务:
  Timer tick (09:00)
    → CronScheduler.onTimer()
    → 从 DB 加载到期 jobs
    → 发占位消息 "⏰ 定时任务执行中..." 到目标 chat/thread，拿到 messageId
    → executeClaudeTask(prompt, chatId, userId, messageId, rootId, threadId, agentId)
    → (复用完整现有流程：队列排队 → workspace 解析 → session resume → 进度卡片 → 结果卡片)
    → 更新 DB: lastRunAtMs, lastStatus, nextRunAtMs
```

## 数据模型

### cron_jobs 表

```sql
CREATE TABLE cron_jobs (
  id              TEXT PRIMARY KEY,           -- nanoid
  name            TEXT NOT NULL,              -- 任务名称
  chat_id         TEXT NOT NULL,              -- 结果发送目标群
  user_id         TEXT NOT NULL,              -- 创建者
  prompt          TEXT NOT NULL,              -- agent 执行的指令
  working_dir     TEXT,                       -- 工作目录（null = 使用默认）
  repo_url        TEXT,                       -- 仓库 URL（如需创建工作区）

  -- 调度
  schedule_kind   TEXT NOT NULL,              -- 'cron' | 'every' | 'at'
  schedule_expr   TEXT,                       -- cron 表达式 (kind=cron)
  schedule_tz     TEXT DEFAULT 'Asia/Shanghai',
  every_ms        INTEGER,                    -- 固定间隔毫秒 (kind=every)
  at_time         TEXT,                       -- ISO 时间戳 (kind=at)

  -- 状态
  enabled         INTEGER NOT NULL DEFAULT 1,
  delete_after_run INTEGER NOT NULL DEFAULT 0, -- 一次性任务执行后删除
  next_run_at_ms  INTEGER,                    -- 下次执行时间
  last_run_at_ms  INTEGER,                    -- 上次执行时间
  last_status     TEXT,                       -- 'ok' | 'error' | 'skipped'
  last_error      TEXT,                       -- 上次错误信息
  last_duration_ms INTEGER,
  consecutive_errors INTEGER DEFAULT 0,

  -- 执行配置
  timeout_seconds INTEGER DEFAULT 300,
  model           TEXT,                       -- 模型覆写
  max_budget_usd  REAL DEFAULT 5,             -- 单次执行预算上限
  agent_id        TEXT DEFAULT 'dev',         -- agent 类型

  -- 话题绑定（可选，用于在已有 thread 中执行）
  thread_id       TEXT,                       -- 飞书话题 ID（null = 群顶层新消息）
  thread_root_message_id TEXT,                -- 话题根消息 ID
  context_snapshot TEXT,                      -- 创建时的上下文快照（注入执行 prompt）

  -- 元数据
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_cron_jobs_next_run ON cron_jobs(next_run_at_ms) WHERE enabled = 1;
CREATE INDEX idx_cron_jobs_chat ON cron_jobs(chat_id);
```

### cron_runs 表（执行历史）

```sql
CREATE TABLE cron_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  started_at_ms   INTEGER NOT NULL,
  ended_at_ms     INTEGER,
  status          TEXT NOT NULL,              -- 'running' | 'ok' | 'error' | 'timeout'
  output          TEXT,                       -- 截断后的执行输出
  error           TEXT,
  cost_usd        REAL,
  duration_ms     INTEGER,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_cron_runs_job ON cron_runs(job_id, started_at_ms DESC);
```

## 核心模块

### 文件结构

```
src/cron/
  types.ts          -- CronJob, CronSchedule, CronRun 类型
  store.ts          -- SQLite CRUD (CronStore)
  scheduler.ts      -- CronScheduler 主调度器 + 执行（调用 executeClaudeTask）
  tool.ts           -- MCP tool: manage_cron
```

### 1. CronStore (`store.ts`)

基于现有 `SessionDatabase` 模式，在 `sessions.db` 中新增表：

```typescript
class CronStore {
  constructor(db: Database.Database)

  // CRUD
  add(job: CronJobCreate): CronJob
  get(id: string): CronJob | undefined
  update(id: string, patch: CronJobPatch): CronJob
  remove(id: string): boolean
  list(opts?: { chatId?: string; enabled?: boolean }): CronJob[]

  // 调度查询
  getDueJobs(nowMs: number): CronJob[]
  getNextWakeAtMs(): number | undefined
  updateJobState(id: string, state: Partial<CronJobState>): void

  // 执行历史
  insertRun(run: CronRunCreate): number
  updateRun(id: number, result: CronRunResult): void
  getRecentRuns(jobId: string, limit?: number): CronRun[]
  cleanOldRuns(maxAgeDays: number): number
}
```

### 2. CronScheduler (`scheduler.ts`)

借鉴 OpenClaw 的 timer 模式：

```typescript
class CronScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private store: CronStore,
    private executor: CronJobExecutor,
    private logger: Logger,
  )

  // 生命周期
  async start(): Promise<void>      // 加载 jobs → 补跑错过的 → armTimer
  stop(): void                       // clearTimeout

  // Timer
  private armTimer(): void           // setTimeout 到最近的 nextRunAtMs
  private async onTimer(): Promise<void>  // 找到期 jobs → 执行 → 更新状态 → re-arm

  // 公开 API（供 MCP tool 调用）
  async addJob(input: CronJobCreate): Promise<CronJob>
  async updateJob(id: string, patch: CronJobPatch): Promise<CronJob>
  async removeJob(id: string): Promise<boolean>
  async listJobs(opts?: ListOpts): Promise<CronJob[]>
  async triggerJob(id: string): Promise<void>   // 手动立即执行
}
```

核心调度逻辑：

```typescript
private async onTimer(): Promise<void> {
  if (this.running) return;
  this.running = true;
  try {
    const nowMs = Date.now();
    const dueJobs = this.store.getDueJobs(nowMs);

    // 串行执行（避免并发竞争 Claude API 配额）
    for (const job of dueJobs) {
      await this.executeJob(job);
    }
  } finally {
    this.running = false;
    this.armTimer();
  }
}

private armTimer(): void {
  if (this.timer) clearTimeout(this.timer);
  const nextAt = this.store.getNextWakeAtMs();
  if (!nextAt) return;

  const delay = Math.min(
    Math.max(nextAt - Date.now(), 2000),  // 最小 2s 防 spin
    60_000,                                // 最大 60s 防 drift
  );

  this.timer = setTimeout(() => {
    this.onTimer().catch(err => this.logger.error({ err }, 'cron: timer failed'));
  }, delay);
}
```

### 3. 执行逻辑（在 `scheduler.ts` 中）

复用 `executeClaudeTask()`，模拟用户 @bot：

```typescript
private async executeJob(job: CronJob): Promise<void> {
  const store = this.store;
  const runId = store.insertRun({ jobId: job.id, startedAtMs: Date.now(), status: 'running' });

  try {
    // 1. 发占位消息到飞书，拿到 messageId
    const placeholder = await feishuClient.sendMessage(
      job.chatId,
      buildCronStartCard(job),
      { rootId: job.threadRootMessageId },  // 发到指定话题
    );
    const messageId = placeholder.message_id;

    // 2. 构造 prompt（注入 cron 上下文前缀）
    const prompt = `[⏰ 定时任务: ${job.name}]\n\n${job.prompt}`;

    // 3. 注入现有流程 —— 和用户 @bot 完全一样
    await executeClaudeTask(
      prompt,
      job.chatId,
      job.userId,          // 创建者的 userId
      messageId,
      job.threadRootMessageId,
      job.threadId,
      undefined,           // images
      job.agentId,
    );

    // 4. 记录成功（executeClaudeTask 内部已发结果卡片）
    store.updateRun(runId, { status: 'ok', endedAtMs: Date.now() });
  } catch (err) {
    store.updateRun(runId, { status: 'error', error: String(err), endedAtMs: Date.now() });
  }
}
```

**关键点**：`executeClaudeTask()` 内部处理了所有的 workspace 解析、session resume、进度卡片、结果卡片。
cron scheduler 只需要负责"什么时候触发"和"记录执行历史"。

### 4. MCP Tool (`tool.ts`)

复用现有 `createSdkMcpServer` 模式，在 workspace tool 旁边注册：

```typescript
// tool name: manage_cron
// actions: list, add, update, remove, trigger, history

// 示例调用
manage_cron({
  action: "add",
  name: "每日日报",
  schedule: "0 9 * * *",           // 标准 cron
  prompt: "检查最近的 git commits，总结今天的开发进度，发送日报",
  timezone: "Asia/Shanghai",       // 可选，默认 Asia/Shanghai
})

manage_cron({
  action: "add",
  name: "30分钟后提醒",
  schedule_kind: "at",
  at: "2026-03-17T10:30:00",       // 一次性
  prompt: "提醒我检查 PR review",
})

manage_cron({
  action: "list",                  // 列出当前 chat 的所有定时任务
})

manage_cron({
  action: "remove",
  id: "xxx",
})
```

## 错误处理

借鉴 OpenClaw 的退避策略：

```typescript
const BACKOFF_SCHEDULE_MS = [
  30_000,       // 1st error → 30s
  60_000,       // 2nd → 1min
  5 * 60_000,   // 3rd → 5min
  15 * 60_000,  // 4th → 15min
  60 * 60_000,  // 5th+ → 1h
];
```

- 错误后指数退避，成功后重置
- 一次性任务 (`at`) 失败后对 rate_limit / timeout 等瞬态错误自动重试 3 次
- 连续失败 3 次发告警到飞书群（可配置）

## 生命周期集成

### 启动 (`index.ts`)

```typescript
// 在 server 启动后、cleanup interval 之前
const cronStore = new CronStore(sessionDb.db);  // 复用 sessions.db
const cronScheduler = new CronScheduler(cronStore, cronExecutor, logger);
if (config.cron.enabled) {
  await cronScheduler.start();
}
```

### 关闭

```typescript
// graceful shutdown 中
cronScheduler.stop();
// 等待正在执行的 cron job 完成（复用 claudeExecutor.waitForRunningTasks）
```

### 清理（30 分钟 interval 中）

```typescript
cronStore.cleanOldRuns(7);  // 清理 7 天前的执行记录
```

## 配置

```env
# .env
CRON_ENABLED=true                    # 是否启用调度器
CRON_TIMEZONE=Asia/Shanghai          # 默认时区
CRON_MAX_CONCURRENT=1                # 最大并发执行数
CRON_DEFAULT_TIMEOUT=300             # 默认超时秒数
CRON_DEFAULT_BUDGET=5                # 默认单次预算 USD
```

## 实施步骤

### Phase 1: 核心调度（MVP）

1. **`src/cron/types.ts`** — 类型定义
2. **`src/cron/store.ts`** — SQLite 存储层 + DB migration (v13)
3. **`src/cron/scheduler.ts`** — 调度器（armTimer + onTimer + 退避 + 调用 executeClaudeTask）
4. **`src/cron/tool.ts`** — MCP tool 注册
5. **`src/index.ts`** — 生命周期集成
6. **`src/config.ts`** — 添加 cron 配置项
7. **`tests/cron/`** — 单元测试

### Phase 2: 增强（后续）

- 执行历史查看（MCP tool: `history` action）
- 飞书卡片操作（暂停/恢复/删除按钮）
- 上下文快照自动摘要（创建 cron 时 agent 自动抓取关键上下文）

## 与 OpenClaw 的差异

| 维度 | OpenClaw | 我们 |
|------|---------|------|
| 存储 | JSON 文件 | SQLite |
| cron 解析 | croner | croner（同款） |
| 执行 | Pi Agent runtime | Claude Agent SDK |
| 结果投递 | Telegram/Discord/40+ 渠道 | 飞书 |
| Session target | main / isolated | 复用 executeClaudeTask（等价 main，自带上下文） |
| 并发控制 | 可配置 maxConcurrentRuns | 串行（Phase 1），可扩展 |
| 管理方式 | JSON 编辑 + CLI | MCP tool（agent 自主管理） |
| 错误退避 | ✅ 指数退避 | ✅ 照搬 |
| 启动补跑 | ✅ missedJobs | ✅ 照搬 |
| 执行超时 | ✅ AbortController | ✅ 复用 executor 超时 |
