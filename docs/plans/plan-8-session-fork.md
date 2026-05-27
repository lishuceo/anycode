---
summary: "Session Fork：从已有话题分叉出新会话，继承对话历史、工作区状态与隐性共识"
status: draft
owner: lishuceo
last_updated: "2026-05-24"
read_when:
  - 实现或修改 session fork 流程
  - 修改 ThreadSession schema 或话题创建逻辑
  - 调整 workspace 隔离策略
  - 设计 fork 失败的回滚或清理逻辑
---

# Plan 8: Session Fork

## 目标

允许用户从一个已经讨论得很深的话题分叉出新会话，继承前置上下文，以便并行尝试多条路线。P0 仅支持「从当前状态 fork」，一周内落地。

## 背景与痛点

Agent 协作中常出现的场景：某个 thread 已经讨论了很多轮，接下来有两条以上路线可以尝试，但路线之间需要共享当前的上下文。当前用户只有三种次优选择：

| 选择 | 代价 |
|------|------|
| 单路线推进 | 失去对另一条路线的真实验证机会 |
| 从零开新会话 | 丢失所有已建立的上下文和共识 |
| 手动复述/总结后开新会话 | 隐性共识难以完整传递，agent 行为出现漂移 |

核心痛点：**高质量 agent session 的上下文建设成本极高，但没有一个轻量的方式把这份资产复用到多条平行探索上**。

类比：git 在没有 branch 之前，开发者只能在 master 上线性提交。fork 之于 session，类似 branch 之于 commit 的「轻量分支」环节 —— 但要注意：git branch 的核心价值是支持**合并**，而本方案 P0~P2 都不支持 fork 合并（P3 待评估）。所以更精确的说法是「fork 是为了**并行探索**而非**并行开发**」。

## 为什么这个需求对 Agent 比对普通 LLM 聊天更刚需

普通 LLM 聊天的 "context" 只是 token；而 agent session 的 context 实际包含三层：

| 层 | 内容 | 处理方式 |
|---|---|---|
| **对话历史** | SDK session 的 JSONL 文件 | 复制原 session 文件，新 conversationId 指向副本 |
| **工作区状态** | 文件树 / 未提交修改 / git 分支 | git worktree + git stash 中转 |
| **隐性共识** | 已在 LLM context 中的认知（代码库理解、用户偏好、前置约束） | 只要前两层复制完，这层自动继承 |

只有同时复制前两层，第三层才能延续。任一层丢失，agent 在新 session 里的行为都会漂移。

## 与现有方案的边界

| 方案 | 适用 | 不适用 / 为什么不够 |
|------|------|--------|
| **Subagent（Agent tool）** | 并行探索、独立子任务 | 父 session 无法继承子 session 学到的东西 |
| **复述/总结后开新会话** | 上下文不深、决策点清晰 | 大量隐性共识丢失（agent 偏好、踩坑记录） |
| **LLM 生成摘要注入新话题首条** | 轻量场景，无 workspace 状态需要继承 | 摘要本身可能漏关键细节；不解决「工作区状态」继承 |
| **Session resume 双指向（只读 fork）** | 仅需对比两个 LLM 输出路径，不修改文件 | SDK resume 是单向的，两个 thread 共享 conversationId 会在 JSONL 里写交叉消息，破坏原 session |
| **手动 `git branch` + 用户复述** | 用户精力充裕、上下文小 | 复述漂移；用户负担重 |
| **Session Fork（本方案）** | 决策树状、上下文昂贵、需要对比 end-to-end | 简单线性任务（杀鸡用牛刀） |

本方案与前几个互补不替代；选 fork 是因为前几个都无法同时解决「对话历史 + 工作区状态 + 隐性共识」三层继承。

## P0 详细设计

### 触发方式

- 命令：`/fork [可选描述]`
- 默认隐藏，仅暴露给重度用户，降低普通用户认知负担
- P1 可在某条回复下加 🔱 「从此处 fork」按钮

### Fork 点粒度

P0 只做「从当前继续 fork」：复制现状，新话题继续推进。

不做「从历史某条消息 fork」（涉及 ThreadSession 历史截断 + tooluse/toolresult 配对处理，留给 P1/P2）。

### 工作目录处理策略

关键决策点：根据原话题是否已 `setup_workspace` 决定行为。

| 原话题状态 | Fork 后新话题的工作目录 | 复制成本 |
|---|---|---|
| 已 setup_workspace | 新建 `.workspaces/<原名>-fork-<短 id>` | 中（worktree + stash） |
| 未 setup_workspace（在 `/root/dev/`） | 共享 `/root/dev/` | 几乎为零 |

#### 场景 A：已 setup_workspace 的会话

**必须新建隔离副本**，严禁复用原 workspace 目录。两个硬约束任一足以否决「原地 fork」：

1. **文件写冲突**：两个 session 并发对同一目录写文件，结果不可预测；agent 对「我刚改了什么」的认知会被另一个 session 覆盖
2. **Git 分支锁**：git worktree 同一分支不能被两个 worktree 同时 checkout，会直接报错

**执行步骤：**

```
原 workspace:  /root/dev/.workspaces/abc-foo            (branch: feat/foo)
fork 后:       /root/dev/.workspaces/abc-foo-fork-<id>  (branch: feat/foo-fork-<id>)
```

1. **新建 worktree**（基于原 HEAD 切新分支，避免分支锁冲突）：
   ```bash
   cd <workspace.git bare repo>
   git worktree add <新路径> -b <原分支>-fork-<短id> <原 HEAD>
   ```
   git worktree 是硬链接 + 独立 checkout，磁盘开销极小、创建毫秒级。

2. **继承未提交修改**（staged / unstaged / untracked 全要）：
   ```bash
   cd <原工作区>
   STASH_REF=$(git stash create)   # 不污染 stash 栈
   cd <新工作区>
   git stash apply $STASH_REF      # 失败则 abort 整个 fork
   ```
   备选：`rsync` 差异文件（git stash 漏 untracked 时兜底）。

3. **复制 SDK session JSONL**（⚠️ 待调研）：
   - 找到原 `conversationId` 对应的 JSONL 文件，复制到新位置生成新 `conversationId`
   - 新 session 后续 resume 时基于副本，不影响原 session
   - **风险**：`@anthropic-ai/claude-agent-sdk` 当前未公开 JSONL 文件路径接口，需要先调研 SDK 内部存储约定（猜测在 `~/.claude/projects/<hash>/<conversationId>.jsonl` 之类位置），或改用 SDK 的 session 复制 API（若有）

4. **创建 ThreadSession 记录**（schema 见下文）

5. **创建飞书新话题**：标题带 `🔱` 前缀，首条系统消息标注血缘

#### 场景 B：未 setup_workspace 的会话

适用于跨仓库讨论、通用问题、项目对比等场景。这类对话几乎不写文件，无需隔离。直接共享 `/root/dev/`，零复制成本。

**理由：**

- `/root/dev/` 本身不是 git 仓库，下面的子项目又是写保护的源仓库（`isInsideSourceRepo()` 会拦截写操作）
- 没有未提交修改要继承
- 没有 worktree 要复制
- 两个会话并发读 `/root/dev/` 完全安全

**步骤：**

1. 不创建 worktree，工作目录字段直接继承 `/root/dev/`
2. 复制 SDK session JSONL（同场景 A 步骤 4）
3. 创建 ThreadSession 记录，`workingDir` 设为 `/root/dev/`
4. 创建飞书新话题

#### 演化边界

如果 fork 后新话题中用户决定要动手改某个仓库的代码，会自然触发 `setup_workspace`。此时新话题进入正常的 workspace 隔离流程（在 `.workspaces/` 下生成新工作区），和原话题彻底分离。原话题的 `workingDir` 仍是 `/root/dev/`，互不影响。

**总结：fork 时的工作目录策略由「当前是否 workspace 化」决定，fork 之后两个话题各自独立演化。**

## Schema 变更

`ThreadSession` 表新增字段：

```sql
ALTER TABLE thread_sessions ADD COLUMN parent_topic_id TEXT;
ALTER TABLE thread_sessions ADD COLUMN forked_from_message_id TEXT;
ALTER TABLE thread_sessions ADD COLUMN fork_point TEXT;
ALTER TABLE thread_sessions ADD COLUMN fork_short_id TEXT;
CREATE INDEX idx_thread_sessions_parent ON thread_sessions(parent_topic_id);
```

字段含义：

- `parent_topic_id`：父话题 ID（飞书 thread id），用于血缘查询
- `forked_from_message_id`：fork 时父 session 最后一条消息的 message id（P1 「从历史点 fork」会用）
- `fork_point`：fork 时父 session JSONL 的末尾 hash 或序号（P2 时光机会用，需与 SDK JSONL 内部 message 序号对齐）
- `fork_short_id`：4-6 字符 hex 短 id，仅用于人类可读的视觉提示

> **注意**：`fork_point` 与 SDK JSONL 内部 message 序号的对齐方式需要在实现时确认（SDK 不保证序号稳定，可能需要存 message 内容 hash）。P0 只写入字段，P2 时光机功能实现时再消费。

## 实现前置依赖（必须先解决）

P0 落地前，以下三件事必须先有结论或原型，否则方案不可执行：

1. **SDK JSONL 文件路径获取**
   - `@anthropic-ai/claude-agent-sdk` 当前**未公开**通过 `conversationId` 获取 JSONL 文件路径的 API
   - 候选方案：a) 反查 SDK 源码定位文件路径约定（猜测 `~/.claude/projects/<projectHash>/<conversationId>.jsonl`）；b) 等 SDK 暴露官方 session 复制 API；c) 我们自己把每轮对话另存一份镜像
   - **未确认前，文档第 4 步「复制 JSONL」不可实现**

2. **飞书新话题创建 API**
   - 当前 `client.ts` 仅有 `createThreadWithCard()` 「在某条消息下回复并隐式建话题」，**没有**直接创建带自定义标题新话题的 API
   - 候选方案：a) bot 先在群里发一条「🔱 fork 提示」消息，自动成为新话题根；b) 调研飞书是否有 `/im/v1/threads/create` 之类的官方 API
   - **未确认前，文档「新话题标题带 🔱 前缀」可能不可控**

3. **Feature flag 机制**
   - 当前无 per-user feature flag 框架，无法实现「默认隐藏，仅重度用户暴露」
   - 候选方案：a) 在 `config.fork.allowedUsers` 加白名单；b) 复用现有 `ALLOWED_USER_IDS`；c) 暂不隐藏，所有用户可见但 `/help` 不列出
   - **P0 可接受方案 c**（最简）

## 并发与原子性

- **Per-chat 队列**：`src/session/queue.ts` 以 `queueKey = chatId:rootId` 串行化。Fork 进入新 threadId → 新队列，与原话题独立，无相互阻塞。
- **原话题 query 进行中的 fork**：若原 session 正在执行长 query，JSONL 在追写中。Fork 必须**等待原话题当前 query 结束**（在原话题队列里排队），否则会复制到半成品 JSONL → SDK resume 失败。
- **新话题首次消息保护**：Fork 完成前在 ThreadSession 标记 `fork_initializing=true`，期间用户在新话题发消息直接排队等候（不进入 Claude），避免读到复制中的 JSONL。
- **JSONL 复制原子化**：先写到 `<新 conversationId>.jsonl.tmp`，整个写完后 atomic `rename`，避免半文件被读。

## 命名规范

- **新话题标题**：`🔱 <原标题>` 或用户在 `/fork` 时自定义
- **新工作区目录**（仅场景 A）：`<原目录名>-fork-<短id>`，例如：
  ```
  原: /root/dev/.workspaces/anycode-feat-claude-session-89684e
  新: /root/dev/.workspaces/anycode-feat-claude-session-89684e-fork-a3f2
  ```
- **新 git 分支**：`<原分支>-fork-<短id>`
- **短 id**：4-6 字符 hex/base36，与 ThreadSession 表主键解耦，仅用于人类可读的视觉提示

## 血缘关系（UI 层）

飞书话题模型是**扁平**的：一个群下所有话题都是同级，没有原生父子嵌套。Fork 出的话题在群侧边栏与原话题平级展示。血缘靠两层维护：

- **数据层**：`ThreadSession.parent_topic_id` + `fork_point` 记录真实血缘，bot 内部精确可查
- **UI 层**：
  - 话题标题前缀 `🔱`
  - Fork 话题首条系统消息固定格式：
    ```
    🔱 从话题《<原标题>》的第 N 条消息 fork
    - Fork 时间：2026-05-24 01:30
    - 源 workspace：<原目录>
    - 新 workspace：<新目录或共享 /root/dev/>
    - 继承对话历史：<N> 轮
    - [点击查看源话题](link)
    ```
  - Bot 内置命令 `/lineage` 显示当前话题的祖先链（P1）
  - `/fork-tree` 可视化完整血缘树（P2）

## Cache 经济性

Anthropic prompt cache 有 5 分钟 TTL：

- Fork 后两条 session 前缀完全相同 → 前几轮 cache 命中率高
- 时间一长各自演化，cache 自然分裂 → 这是预期行为，因为 fork 的目的就是分化

**结论：无需为 cache 做额外优化**。

## 失败处理与回滚

Fork 涉及多个外部状态变更（worktree、stash、JSONL 复制、DB 记录、飞书话题创建），任一步失败必须能干净回滚。

执行顺序与失败处理：

| 步骤 | 失败时回滚动作 |
|------|----------------|
| 1. 新 worktree | 无需回滚 |
| 2. Stash apply（含 `-u` 含 untracked） | `git worktree remove --force <新路径>` + `git branch -D <新分支>` |
| 3. JSONL 复制（写临时文件后 atomic rename） | 上述全部 + `rm <新 JSONL>` |
| 4. ThreadSession 写入 | 上述全部 + `DELETE FROM thread_sessions WHERE thread_id=...` |
| 5. 飞书话题创建 | **保留现场不清理**，在 DB 标记 `status='fork_pending'`，提供 `/fork-retry` 手动恢复（避免清理后用户无法重做） |

**原则：飞书话题创建放在最后，但失败时不能简单清理**，否则用户面对「fork 失败」却无法重做。`fork_pending` 状态让用户能手动重试创建话题，或主动放弃。

## 未跟踪产物处理

`node_modules`、`dist/`、`.next/`、构建缓存等未跟踪大体积产物：

- **默认不复制**：worktree 共享 git objects，但 untracked 文件由 stash apply 处理；体积过大时 stash 会很慢
- **检测策略**：fork 前检查未跟踪文件总大小，超过阈值（如 100MB）时提示用户「检测到大量未跟踪文件，是否跳过？」
- **跳过时**：新 worktree 需要用户在新话题里重跑 `npm install` 等命令

## UI/UX

- **触发命令**：`/fork [可选描述]`
- **进度提示**：fork 涉及 worktree + stash + session 复制，可能需要 1-3 秒，期间在原话题显示「正在创建分叉...」
- **完成回复**：在原话题贴出新话题链接 + 简短摘要
- **新话题首条消息**：见上文「血缘关系」UI 层格式

## 路线图

为了把「需求验证」放在「重工程」前面，P0 拆为两个子阶段：

| 阶段 | 范围 | 工期 | 目的 |
|------|------|------|------|
| **P-1（验证）** | 不写代码，复盘最近 3-5 个真实 session，统计若有 fork 能力的使用率 | 2 天 | 决定是否做 P0a |
| **P0a** | 仅场景 B（未 setup workspace，共享 `/root/dev/`），只复制 JSONL + 建话题 | 3-5 天 | 验证 UX、`/fork` 命令、JSONL 复制是否可行 |
| **P0b** | 场景 A（已 setup workspace，worktree + stash） | 1 周 | P0a 验证 fork 真有人用后再做 |
| P1 | `/lineage` 命令；从历史某条消息 fork；回复下 🔱 按钮 | 2-3 天 | |
| P2 | `/fork-tree` 可视化；自动归档长期不活跃 fork；时光机（基于 fork_point 回放） | 2 周+ | |
| P3 | Fork 合并 / cherry-pick 对话片段；fork 之间的差异对比 UI | 待评估 | 决定 fork 是否真的「类比 git branch」 |

**P0a/P0b 的退出标准**：P0a 上线两周内若使用率 >20%（活跃用户中），启动 P0b；<10% 则停在 P0a 或下线。

## 风险与对策

| 风险 | 严重度 | 对策 |
|------|--------|------|
| 用户用不来，认知负担过高 | 中 | 默认隐藏，仅重度用户暴露；命令式入口而非 UI 按钮 |
| 话题列表膨胀，难以管理 | 中 | 前缀 🔱 标识 + P1 提供归档/折叠能力 |
| 脏修改迁移失败，新 worktree 状态不一致 | 高 | Fork 前先做 dry-run 校验；失败按上文「失败处理与回滚」流程清理 |
| 磁盘占用增长 | 低 | Worktree 本身共享 objects；大量 untracked 时按上文策略提示用户 |
| 用户误以为两个 fork 共享文件 | 高 | 首条系统消息明确告知「两个工作区互不影响」 |
| Worktree 创建失败（磁盘满 / 权限） | 中 | 整个 fork 流程原子化，任一步失败回滚 + 通知用户 |
| Session 文件膨胀（每次 fork 全量复制） | 低 | P0 接受，未来可改为 COW 或软链 |
| Non-workspace fork 并发改文件冲突 | 低 | 概率极低（系统引导只读），真要改会走 `setup_workspace` 自动隔离 |
| Fork 链过长导致 ThreadSession 索引爆炸 | 低 | `parent_topic_id` 加索引，查询血缘走递归 CTE |

## 验证方法

挑 3-5 个最近的真实 session 复盘：如果当时有 fork 能力，多少个会用？

- **>30%**：ROI 极高，按 P0 计划推进
- **10%-30%**：值得做，但优先级可后置
- **<10%**：可能高估了需求，需要更多用户访谈

## 不在 P0 范围

- 从历史任意时间点 fork（需要 tool result 截断 + JSONL 重放 + workspace 时光机）
- Fork 合并 / cherry-pick 对话片段
- Fork 之间的差异对比 UI
- 自动 fork 建议（基于话题长度/分歧检测）

## 关键决策一览

| 决策 | 选择 | 理由 |
|------|------|------|
| Fork 粒度（P0） | 仅「从当前 fork」 | 避免 JSONL 截断复杂度 |
| Workspace 隔离方式 | 新建 worktree + 新分支 | 避免分支锁与文件写冲突 |
| Non-workspace 工作目录 | 共享 `/root/dev/` | 只读场景，零复制成本 |
| 触发方式 | `/fork` 命令，默认隐藏 | 降低普通用户认知负担 |
| 飞书 UI 层 | 并列话题 + 前缀 🔱 + 首条系统消息 | 飞书无原生父子话题嵌套 |
| 血缘关系存储 | anycode 数据库（`parent_topic_id`） | 飞书侧仅展示，逻辑自管 |
| 失败回滚顺序 | 飞书话题创建放最后 | 避免孤儿话题 |
| 未跟踪大产物 | 默认提示用户跳过 | 避免 stash 卡顿 |

## 相关文档

- [thread-session-mapping.md](../design/thread-session-mapping.md) - ThreadSession 表结构
- [design-per-thread-workspace.md](../design/design-per-thread-workspace.md) - Per-thread workspace 模型
- [workspace-cache-and-restart.md](../design/workspace-cache-and-restart.md) - Workspace 缓存与 restart 流程

## 附录：与姜黎讨论过程中的关键 Q&A

**Q1：P0 fork 是在原目录还是新目录？**
→ 必须新建目录，两个硬约束（文件写冲突 / git 分支锁）任一足以否决原地 fork。

**Q2：飞书上的新话题是跟原话题并列吗？**
→ 是。飞书话题模型扁平，没有原生嵌套；血缘靠元数据 + 前缀 🔱 + 首条系统消息维护。

**Q3：非 workspace 会话（在 `/root/dev/`）fork 后工作目录怎么处理？**
→ 直接共享 `/root/dev/`，零复制成本。因为这类会话本质是只读探索，没有脏状态需要继承；若新话题后续要改代码会自然触发 `setup_workspace`，进入正常隔离流程。

**Q4：默认是否对所有用户开放？**
→ 默认隐藏，仅重度用户通过 `/fork` 命令使用。类比 `git rebase` —— 多数人用不到，但用到的人离不开。
