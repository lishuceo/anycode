# 工作区缓存与 Agent 自动重启方案

## 背景与问题

当前系统中，用户通过飞书发消息触发 Claude Agent 执行任务。Agent 通过 `setup_workspace` MCP tool 在运行时 clone 仓库并切换工作目录。这一机制存在以下问题：

### 问题 1：CLAUDE.md 无法在当前 query 中生效

Agent SDK 在 `query()` 启动时根据 `cwd` + `settingSources: ['project']` 加载项目配置（CLAUDE.md）。当 `setup_workspace` 在 query 执行过程中切换了工作目录，当前子进程的 `cwd` 不会改变，新仓库的 CLAUDE.md 不会被加载。只有下一次 query 才能正确加载。

**影响**：首次访问某个仓库时，Claude 缺少该项目的上下文指导（代码规范、架构说明、命令约定等），可能产出不符合项目规范的结果。

### 问题 2：只读查询也要走完整 clone 流程

用户问"看看 foo/bar 的架构"，当前流程仍然要完整 clone 仓库并创建 feature 分支，耗时且不必要。

### 问题 3：同一仓库被反复 clone

不同用户、不同会话访问同一仓库，每次都从远程 clone，浪费时间和带宽。

### 问题 4（已有缺陷）：taskQueue 未被集成

当前 `executeClaudeTask()` 没有通过 `taskQueue` 串行化执行。如果两条消息快速到达同一个 chat，会并发执行两个 query，导致 `runningQueries` Map 中同一 key 被覆盖、session 状态竞态等问题。本方案的 restart 机制会放大此问题（restart 期间更容易有第二条消息到达）。

**前置要求**：实施本方案前应先修复 `taskQueue` 集成，确保同一 chat 的 query 串行执行。

## 方案概述

引入 **仓库缓存层** 和 **Agent 自动重启机制**，统一解决上述问题：

1. **仓库缓存目录**：维护一组本地 bare clone 镜像，作为快速 clone 源
2. **setup_workspace 增加 readonly/writable 模式**：Claude 根据语义自主判断访问模式
3. **工作区变更后自动重启 query**：确保新 query 以正确的 `cwd` 启动，CLAUDE.md 从一开始就生效

### 曾考虑但放弃的替代方案

- **预解析 CLAUDE.md 方案**：`setup_workspace` 完成后由 MCP tool 读取新仓库 CLAUDE.md 内容注入给 Claude。绕过了 SDK 标准加载机制，可能丢失 `.claude/` 目录下的其他配置。
- **System prompt 动态拼接**：检测到 URL 后先 clone 再拼接 CLAUDE.md 到 system prompt。与 Claude 自主判断是否需要 workspace 的设计理念冲突，且正则检测缺乏语义理解能力。
- **缓存使用普通 clone（非 bare）共享工作树**：多 session 共享同一工作树存在写入污染和 `git checkout` 并发冲突的根本性问题，详见"风险与考量"。

## 分阶段实施计划

建议分两阶段交付，降低一次性变更的风险：

- **Phase 1（核心价值）**：实现 restart 机制 + git 安全参数，解决 CLAUDE.md 不生效问题。不引入缓存层，仍然每次从远程 clone。
- **Phase 2（性能优化）**：引入 bare clone 缓存层 + readonly/writable 模式，优化 clone 速度和只读查询体验。

## 详细设计

### 1. 目录结构

```
/repos/cache/                          # 仓库缓存根目录 (可配置)
  github.com/
    foo/bar.git/                       # bare clone，无工作树
    baz/qux.git/
  gitlab.com/
    org/group/project.git/             # 支持多级 group 路径

/workspaces/                           # 隔离工作区根目录 (可配置)
  {session-key}/                       # 按 session 隔离
    bar/                               # 从缓存 local clone，带工作树和 feature branch
```

### 2. 仓库缓存管理

#### 2.1 缓存策略

缓存采用 **bare clone**（`git clone --bare`），不维护工作树。这从根本上消除了多 session 共享工作树带来的写入污染和并发切分支冲突。readonly 和 writable 模式都通过从 bare cache 做 local clone 获得独立的工作树。

| 操作 | 触发时机 | 说明 |
|------|---------|------|
| 创建缓存 | 首次访问某仓库时 | `git clone --bare <remote-url> <cache-path>` |
| 更新缓存 | 每次使用前 | `git fetch --all`（如最近 N 分钟内已 fetch 则跳过） |
| 清理缓存 | 定时任务 | 超过 `REPO_CACHE_MAX_AGE_DAYS` 未访问或总大小超过 `REPO_CACHE_MAX_SIZE_GB` 时按 LRU 清理 |

所有 git 操作必须携带安全参数：

```bash
# clone 时
git clone --bare \
  --config core.hooksPath=/dev/null \
  --no-recurse-submodules \
  -c protocol.file.allow=never \
  <remote-url> <cache-path>

# fetch 时
git -C <cache-path> fetch --all \
  --no-recurse-submodules \
  -c protocol.file.allow=never
```

#### 2.2 缓存路径映射

从仓库 URL 到缓存路径的映射规则：

```
https://github.com/foo/bar.git      →  {REPO_CACHE_DIR}/github.com/foo/bar.git
git@github.com:foo/bar.git          →  {REPO_CACHE_DIR}/github.com/foo/bar.git
https://gitlab.com/org/sub/proj     →  {REPO_CACHE_DIR}/gitlab.com/org/sub/proj.git
https://git.corp.com:8443/org/repo  →  {REPO_CACHE_DIR}/git.corp.com:8443/org/repo.git
```

**解析规则：**

- 使用 Node.js `URL` 类解析 HTTP(S) URL，用专用逻辑解析 `git@host:path` 格式
- 剥离认证信息（userinfo 部分），只保留 `host[:port]/path`
- 去除 `.git` 后缀后再统一追加 `.git`，确保一致性
- **路径段统一转为小写**（GitHub/GitLab URL 大小写不敏感，但 Linux 文件系统敏感）
- 每个路径段禁止 `..`、空段、以 `.` 开头的段名

**路径穿越防护**：最终生成的缓存路径用 `path.resolve()` 解析后，校验 `resolvedPath.startsWith(REPO_CACHE_DIR)`，不满足则拒绝。

#### 2.3 并发安全

由于缓存为 bare clone（无工作树），并发风险大幅降低：

- **local clone 并发读取 bare cache**：Git 原生支持，多个 `git clone <bare-cache>` 可安全并发
- **`git fetch` 与 local clone 的竞态**：`git fetch` 更新 refs 和 pack 文件期间，`git clone` 可能获得不一致状态。使用文件锁（`flock`）互斥 fetch 和 clone 操作
- **多个 fetch 并发**：通过 flock 串行化，同一缓存目录同一时间只有一个 fetch

#### 2.4 原子性与故障恢复

缓存创建和工作区创建使用临时目录 + rename 策略，确保目录要么完整存在、要么不存在：

```
1. git clone --bare <remote> <cache-path>.tmp-{uuid}
2. rename <cache-path>.tmp-{uuid} → <cache-path>    # 同一文件系统上原子操作
```

- clone 失败时清理 `.tmp-*` 残留目录
- 服务启动时扫描并清理 `REPO_CACHE_DIR` 和 `WORKSPACE_ROOT_DIR` 下的 `.tmp-*` 目录

### 3. setup_workspace MCP tool 改造

#### 3.1 接口变更

新增 `mode` 参数：

```typescript
{
  repo_url?: string,          // 远程仓库 URL
  local_path?: string,        // 本地仓库路径
  mode: 'readonly' | 'writable',  // 新增：访问模式
  source_branch?: string,     // 源分支
  feature_branch?: string,    // feature 分支名 (仅 writable 模式有效)
}
```

#### 3.2 执行逻辑

**readonly 模式**：

```
1. 解析 repo_url → 生成缓存路径 (含路径穿越校验)
2. 缓存不存在？→ git clone --bare <remote> <cache-path> (带安全参数，原子创建)
3. 缓存已存在？→ git fetch --all (带 flock，近期已 fetch 则跳过)
4. git clone <bare-cache> <workspace-path> (local clone，秒级完成)
5. 如指定 source_branch → git checkout <source_branch>
6. 设置 cwd = workspace-path
7. 触发 onWorkspaceChanged 回调
```

**writable 模式**：

```
1. 解析 repo_url → 生成缓存路径 (含路径穿越校验)
2. 缓存不存在？→ git clone --bare <remote> <cache-path> (带安全参数，原子创建)
3. 缓存已存在？→ git fetch --all (带 flock，近期已 fetch 则跳过)
4. git clone <bare-cache> <workspace-path> (local clone，秒级完成)
5. 设置远程 URL 为原始远程地址 (剥离认证信息): git remote set-url origin <sanitized-remote>
6. git checkout -b <feature_branch> [source_branch]
7. 设置 cwd = workspace-path
8. 触发 onWorkspaceChanged 回调
```

> **注意**：`local_path` 参数在 readonly 模式下直接将 cwd 指向该路径（无需缓存/clone），writable 模式下从该路径 local clone 到隔离工作区（与现有行为一致）。

#### 3.3 Claude 的 system prompt 引导

更新 `WORKSPACE_SYSTEM_PROMPT`，让 Claude 理解两种模式的区别：

```
**模式选择:**
- mode='readonly': 只需要阅读、分析、理解代码时使用。不会创建 feature 分支。
- mode='writable': 需要修改代码、提交变更时使用。会创建隔离工作区和 feature 分支。

**重要:** 调用 setup_workspace 后，系统将自动重启以加载项目配置。
请在调用后仅输出简短确认（如"工作区已就绪"），不要继续执行后续任务。
```

### 4. Agent 自动重启机制

#### 4.1 核心流程

```
用户消息
  │
  ▼
executeClaudeTask(prompt, workingDir)
  │
  ▼
query() 启动，cwd = 当前 workingDir
  │    maxTurns = 5, maxBudgetUsd = 0.5 (workspace setup 专用限制)
  │    注：如 Claude 判断不需要 setup_workspace，在此限制内正常执行完毕也可；
  │        但若 output 为空或任务明显未完成，不触发 restart 也不重新执行
  │
  ├─ Claude 判断不需要切换仓库 → 正常执行 → 返回结果
  │
  └─ Claude 调用 setup_workspace → onWorkspaceChanged 触发
       │
       ▼
     设置 workspaceChanged = true，记录 newWorkingDir
       │
       ▼
     当前 query 自然结束（Claude 输出 "工作区已就绪"）
       │
       ▼
     executor 返回结果，携带 restart 信号
       │
       ▼
     event-handler 检测到 restart 信号
       │
       ▼
     清空 session.conversationId（避免残留指向短 session）
       │
       ▼
     更新进度卡片（"正在加载项目配置..."）
       │
       ▼
     发起新 query:
       prompt = 原始用户请求
       cwd = newWorkingDir
       不提供 setup_workspace MCP tool（防止循环）
       不传 resumeSessionId（全新 session）
       使用正常的 maxTurns / maxBudgetUsd
       │
       ▼
     新 query 加载新仓库的 CLAUDE.md ✓ → 正常执行 → 返回最终结果
       │
       ▼
     更新同一张进度卡片为最终结果
```

#### 4.2 executor 改造

`ClaudeExecutor.execute()` 签名变更：

```typescript
async execute(
  sessionKey: string,
  prompt: string,
  workingDir: string,
  resumeSessionId?: string,
  onProgress?: ProgressCallback,
  onWorkspaceChanged?: (newDir: string) => void,
  options?: {
    maxTurns?: number;          // 覆盖默认的 50
    maxBudgetUsd?: number;      // 覆盖默认的 5
    disableWorkspaceTool?: boolean;  // 不注入 setup_workspace MCP tool
  },
): Promise<ClaudeResult>
```

返回值增加 restart 相关字段：

```typescript
interface ClaudeResult {
  // ... 现有字段
  needsRestart?: boolean;       // 是否需要重启
  newWorkingDir?: string;       // 新的工作目录
}
```

在 `onWorkspaceChanged` 回调中记录状态：

```typescript
let workspaceChanged = false;
let newWorkingDir: string | undefined;

const onWorkspaceChangedWrapped = (newDir: string) => {
  workspaceChanged = true;
  newWorkingDir = newDir;
  onWorkspaceChanged?.(newDir);  // 仍然更新 session
};
```

MCP server 注入逻辑：

```typescript
const mcpServers = options?.disableWorkspaceTool
  ? {}
  : { 'workspace-manager': createWorkspaceMcpServer(onWorkspaceChangedWrapped) };
```

#### 4.3 event-handler 改造

在 `executeClaudeTask` 中处理 restart：

```typescript
const result = await claudeExecutor.execute(
  sessionKey, prompt, session.workingDir, session.conversationId,
  onProgress, onWorkspaceChanged,
  { maxTurns: 5, maxBudgetUsd: 0.5 },  // workspace setup 阶段的限制
);

if (result.needsRestart && result.newWorkingDir) {
  // 清空残留的 conversationId
  sessionManager.setConversationId(chatId, userId, '');

  // 更新进度卡片
  await feishuClient.updateCard(progressMsgId, buildProgressCard(prompt, '正在加载项目配置...'));

  // 以新工作目录重新执行
  const restartResult = await claudeExecutor.execute(
    sessionKey,
    prompt,                    // 原始用户请求
    result.newWorkingDir,      // 新的工作目录
    undefined,                 // 不 resume，全新 session
    onProgress,
    undefined,                 // 不传 onWorkspaceChanged
    { disableWorkspaceTool: true },  // 不注入 setup_workspace MCP tool
  );

  // 用 restartResult 更新卡片（流程与现有逻辑相同）
  // ...
  return;
}

// 无 restart，正常更新卡片（现有逻辑）
```

#### 4.4 防止无限循环

三层防护，确保 restart 最多发生一次：

1. **语义层**：restart 后 `cwd` 已是目标仓库，Claude 不会再判断需要 clone
2. **工具层**：restart query 中通过 `disableWorkspaceTool: true` 完全移除 `setup_workspace` MCP tool，即使 Claude 想调用也找不到该工具
3. **回调层**：不传 `onWorkspaceChanged`，即使意外触发也不会设置 `needsRestart`

#### 4.5 restart 期间的 abort 处理

用户可能在第一次 query 结束和 restart query 开始之间发送 `/stop` 命令。在发起 restart query 前检查 session 状态：

```typescript
if (result.needsRestart && result.newWorkingDir) {
  // 检查是否被用户中断
  const currentSession = sessionManager.get(chatId, userId);
  if (!currentSession || currentSession.status !== 'busy') {
    logger.info({ chatId, userId }, 'Restart cancelled: session no longer busy');
    return;
  }
  // ... 继续 restart
}
```

### 5. 配置项

新增环境变量：

```bash
# 仓库缓存
REPO_CACHE_DIR=/repos/cache              # 缓存根目录
REPO_CACHE_MAX_AGE_DAYS=30               # 缓存最大保留天数
REPO_CACHE_MAX_SIZE_GB=50                # 缓存最大总大小，超过按 LRU 清理
REPO_CACHE_FETCH_INTERVAL_MIN=10         # 同一仓库两次 fetch 的最小间隔（分钟）

# 隔离工作区
WORKSPACE_ROOT_DIR=/workspaces           # 工作区根目录 (现有 DEFAULT_WORK_DIR 的替代)
```

### 6. 对现有功能的影响

| 功能 | 影响 | 说明 |
|------|------|------|
| `/project` 命令 | 无变化 | 手动切换目录，下次 query 自然生效 |
| `/workspace` 命令 | 改为使用缓存层 | 速度提升，行为不变 |
| `/reset` 命令 | 无变化 | 重置 session，清除 conversationId |
| session resume | 行为变化 | restart 前清空 conversationId，restart 后保存新 session 的 ID |
| 多用户并发 | 需先修复 taskQueue | 缓存层通过 bare clone + flock 保证安全，工作区按 session 隔离 |

## 实现步骤

### Phase 1：restart 机制（核心价值）

1. **前置：集成 taskQueue** — 确保 `executeClaudeTask` 通过 taskQueue 串行化执行
2. **新增配置项** — `WORKSPACE_ROOT_DIR` 等 restart 相关配置
3. **改造 `src/claude/executor.ts`** — `execute()` 增加 `options` 参数、返回值增加 `needsRestart` / `newWorkingDir`、包装 `onWorkspaceChanged` 回调、支持 `disableWorkspaceTool`
4. **改造 `src/feishu/event-handler.ts`** — `executeClaudeTask` 增加 restart 逻辑（清空 conversationId → 更新卡片 → 重新执行）
5. **更新 system prompt** — 引导 Claude 在调用 `setup_workspace` 后立即结束
6. **增加 git 安全参数** — 在 `src/workspace/manager.ts` 的所有 git 操作中添加 `core.hooksPath=/dev/null`、`--no-recurse-submodules`、`-c protocol.file.allow=never`

### Phase 2：缓存层 + readonly/writable 模式

7. **新增配置项** — `REPO_CACHE_DIR`、`REPO_CACHE_MAX_AGE_DAYS`、`REPO_CACHE_MAX_SIZE_GB`、`REPO_CACHE_FETCH_INTERVAL_MIN`
8. **新增 `src/workspace/cache.ts`** — bare clone 缓存管理（URL 解析与路径穿越校验、缓存创建/更新/清理、flock 并发控制、原子目录创建）
9. **改造 `src/workspace/manager.ts`** — `setupWorkspace` 增加 `mode` 参数，接入缓存层
10. **改造 `src/workspace/tool.ts`** — MCP tool schema 增加 `mode` 参数
11. **更新 system prompt** — 增加 readonly/writable 模式选择引导
12. **缓存清理** — 在现有的 30 分钟 cleanup interval 中加入过期缓存清理、服务启动时清理 `.tmp-*` 残留、session 过期时联动删除磁盘上的工作区目录

> 步骤 3-4（executor/event-handler restart 改造）与步骤 8（cache 模块）相互独立，可并行开发。

## 风险与考量

### 磁盘空间

缓存目录会持续增长。通过 `REPO_CACHE_MAX_AGE_DAYS` 和 `REPO_CACHE_MAX_SIZE_GB` 双重控制，清理任务定期执行。Session 过期时应联动删除磁盘上的工作区目录（当前的 `sessionManager.cleanup()` 只删除数据库记录）。大型 mono-repo 可考虑 `--depth=1` shallow clone 作为缓存。

### Git 安全

对用户提供的任意仓库 URL 执行 git 操作存在风险：

- **Git hooks**：恶意仓库可通过 hooks 在 clone 时执行任意命令。通过 `core.hooksPath=/dev/null` 禁用。
- **Submodules**：恶意仓库可通过 `.gitmodules` 指向内网地址（SSRF）或触发递归 clone。通过 `--no-recurse-submodules` 和 `-c protocol.file.allow=never` 禁用。
- **认证信息泄露**：`git remote set-url origin` 时必须剥离 URL 中的 userinfo 部分，避免凭据写入 `.git/config` 被 Claude 读取。
- **可选加固**：仓库 URL 主机名白名单（只允许 `github.com`、`gitlab.com` 及配置的私有实例）。

### 重启带来的额外耗时

restart 意味着两次 query 调用。第一次 query 通过 `maxTurns: 5` 和 `maxBudgetUsd: 0.5` 限制开销，确保快速结束。进度卡片分阶段更新（"配置工作区..." → "加载项目配置..." → "执行任务..."），让用户了解进展。

### 缓存一致性

缓存仓库可能不是最新的。每次使用前执行 `git fetch --all` 可以缓解，通过 `REPO_CACHE_FETCH_INTERVAL_MIN` 控制 fetch 频率避免大型仓库的重复 fetch 开销。对于大多数使用场景（代码分析、bug 修复），短暂的不一致窗口是可以接受的。

### CLAUDE.md prompt injection

恶意仓库的 CLAUDE.md 可能包含 prompt injection 内容。这是 Claude Code Agent SDK `settingSources: ['project']` 机制的固有信任边界问题，并非本方案引入。restart 机制使该风险更为显式（restart 的明确目的就是加载目标仓库的 CLAUDE.md），但不改变风险的性质。确保 `canUseTool` 安全策略在 restart query 中同样生效即可。
