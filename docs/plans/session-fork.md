---
summary: "Session Fork 特性：从已有会话分叉出新会话，继承对话历史 + 工作区状态 + 隐性共识，用于探索多条路线"
status: draft
owner: lishuceo
last_updated: "2026-05-24"
read_when:
  - 实现 Session Fork / 会话分叉相关功能
  - 修改 session manager、workspace manager、thread context
  - 设计多分支探索、A/B 实验类交互
  - 调整飞书话题模型或工作区命名规范
---

# Session Fork — 会话分叉特性设计方案

## 1. 背景与痛点

在使用 agent 处理复杂任务时,经常出现这样的场景：

- 一个 session 已经讨论了几十轮,包含大量上下文（需求澄清、设计决策、已尝试的方案）
- 接下来有 2~3 条可行路线值得分别尝试
- 但每条路线都依赖**完整的前置上下文**——简单地"新开一个会话从零讲一遍"成本极高
- 在原 session 里串行试又会污染上下文（试错记录会让 agent 困惑）

目前的 workaround：要么硬着头皮串行试,要么手动复制 prompt 重开,后者会丢掉工作区状态和隐性共识。

## 2. 三层 Context 分析

Session 的"上下文"由三层组成,Fork 必须同时处理这三层,否则会出现**认知撕裂**：

| 层 | 内容 | 存储位置 | Fork 难度 |
|----|------|----------|-----------|
| L1 对话历史 | JSONL transcript（user/assistant/tool messages） | `~/.claude/projects/<workspace-id>/*.jsonl` | 易（拷贝文件） |
| L2 工作区状态 | git worktree、未提交修改、`.cli/logs` runtime 状态 | `/root/dev/.workspaces/<name>/` | 中（需 git worktree + 文件拷贝） |
| L3 隐性共识 | agent 对文件结构、命名约定、用户偏好的"默认假设" | 编码在 L1 + L2 的交互中 | 自动继承（只要 L1+L2 正确） |

**核心难点**：仅复制 L1 会让 agent 在新会话里以为某些文件存在或处于某状态,但实际工作区是另一份副本（甚至空目录）,从而产生幻觉性的修改建议。

## 3. 与现有方案对比

| 方案 | 继承对话 | 继承工作区 | 隔离写入 | 适用场景 |
|------|----------|------------|----------|----------|
| 新开 session | ❌ | ❌ | ✅ | 无关新任务 |
| 同 session 串行 | ✅ | ✅ | ❌ | 单线推进 |
| 飞书话题（thread） | 部分 | ✅（共享） | ❌ | 平行子话题但共享 workspace |
| **Session Fork（本方案）** | ✅ | ✅（独立副本） | ✅ | **多路线探索** |

## 4. P0 详细设计

### 4.1 触发方式

- 命令：`/fork`（在原 session 中由用户主动触发）
- **入口默认隐藏**——不出现在快捷菜单/帮助首屏,只在文档和重度用户的隐藏菜单（右键/`/help` 二级）中暴露,避免普通用户认知负担

### 4.2 Workspace 场景

原 session 已通过 `setup_workspace` 绑定了某个仓库,工作目录形如 `/root/dev/.workspaces/<repo>-<branch-hash>/`。

**Fork 步骤**：

1. **生成新工作区名**：`<原工作区名>-fork-<短 id>`,如 `anycode-feat-foo-a3f2` → `anycode-feat-foo-a3f2-fork-7b91`
   - 命名规范保证在文件系统层就能识别血缘关系
2. **创建新 git worktree**：从原工作区的当前 HEAD 创建新 worktree 到新路径
3. **迁移未提交修改**：
   - `git diff` + `git diff --cached` → patch → 在新 worktree apply
   - 处理 untracked 文件（按 `.gitignore` 之外的 untracked 全量复制）
4. **复制 runtime 状态**：将 `.cli/logs` 等运行时目录原样复制（私有 workspace_runtime.git 跟踪）
5. **复制 JSONL 对话历史**：`~/.claude/projects/<old-workspace-id>/*.jsonl` → `~/.claude/projects/<new-workspace-id>/`
6. **创建飞书新话题**：并列于原话题,标题加 `[fork]` 或 `↳` 前缀,首条消息附"已从 #<原话题> 分叉,上下文已继承"提示
7. **更新 session DB**：在 `thread_sessions` 表中为新 thread 创建记录,绑定新 workdir + 新 conversationId（指向新 JSONL）

### 4.3 非 Workspace 场景

原 session 没有 setup_workspace,工作目录通常是 `/root/dev/`（聊天涉及跨仓库、通用问题或项目对比）。

此类场景的共同特征是**几乎不会发生文件写操作**,因此：

- **直接共享 `/root/dev/`**,不复制目录
- 仅复制 JSONL 对话历史
- 创建飞书新话题
- 在 session DB 标注 fork 关系但 workdir 相同

如果 fork 后用户在新会话里执行了 `setup_workspace`,从那一刻起回到 4.2 的隔离逻辑（创建独立 workspace）。

### 4.4 关键不变量

- 新会话从创建起就有完整的 L1 + L2,agent 不会"忘记"前面讨论过什么,也不会对文件状态产生幻觉
- 原会话**完全不受影响**,可以继续推进自己的路线
- 命名规范让用户在 `ls .workspaces/` 时一眼看出谁是谁的 fork

## 5. 命名规范

| 对象 | 规范 | 示例 |
|------|------|------|
| 工作区目录 | `<原名>-fork-<8 位短 id>` | `anycode-main-fc56bb-fork-7b91d2a8` |
| Git branch | `fork/<原 branch>/<短 id>` | `fork/feat/claude-session/7b91d2a8` |
| Conversation ID | 新 UUID,DB 中记录 `parent_conversation_id` | — |
| 飞书话题标题 | `↳ <原标题>` 或 `[fork] <原标题>` | `↳ Session Fork 设计讨论` |

## 6. UI 设计

- 命令：`/fork`（无参,从当前消息位置 fork）
- 进度卡片：显示 fork 进度（拷贝工作区 → 拷贝对话 → 创建话题）
- 完成卡片：显示新工作区路径 + 新话题链接 + "已继承 N 轮对话"

**避免暴露过深**：列表展示、批量管理、可视化分叉树等留到 P1+,P0 只做单次 fork 操作。

## 7. 路线图

### P0（一周内落地）

- [x] 方案文档
- [ ] `/fork` 命令实现（workspace + non-workspace 两种场景）
- [ ] DB schema：`thread_sessions` 增加 `parent_thread_id`、`parent_conversation_id` 字段
- [ ] 工作区拷贝逻辑（git worktree + 未提交修改迁移 + runtime 状态复制）
- [ ] JSONL 复制 + conversation ID rebind
- [ ] 飞书新话题创建 + 标题前缀
- [ ] 单元测试：工作区隔离性验证、对话继承验证

### P1（按需）

- [ ] Fork 关系可视化：在卡片上展示 "本会话 fork 自 #xxx,有 2 个子分支"
- [ ] 选择性 fork：`/fork --from <message-id>` 从历史某条消息点 fork（截断之后的对话）
- [ ] 合并提示：当某条 fork 路线被验证为最优时,提示"将变更 cherry-pick 回主线"

### P2（远期）

- [ ] Fork 树状视图（飞书卡片或 Web 面板）
- [ ] 自动 GC：超过 N 天未活跃的 fork 工作区清理
- [ ] 跨 fork diff：对比两条路线产出的代码差异

## 8. 风险与对策

| 风险 | 对策 |
|------|------|
| Fork 工作区无限增长占用磁盘 | P0 阶段记录 fork 时间,P2 增加 GC 策略;命名规范让人工清理也容易 |
| JSONL 内嵌的工具调用引用了原 workspace 路径 | 复制时不改写路径——Claude Code 通过 conversation 中的 cwd 字段定位,新会话 cwd 已切换到新 workdir |
| 未提交修改 apply 失败（冲突） | 新 worktree 从同一 HEAD 创建,理论上无冲突;失败则回退到"只复制对话不复制 worktree"模式并告警 |
| 用户误用导致 fork 泛滥 | 入口隐藏 + 命令式触发(不做按钮)是天然门槛 |
| 飞书话题模型限制 | 新 thread 必须与原 thread 并列,无法嵌套——通过标题前缀和 DB parent_thread_id 关系维持血缘 |

## 9. 验证方法

- 单元测试：fork 后两个 workspace 的文件互不影响（在 A 中写文件,B 中看不到）
- 集成测试：在原 session 讨论 10+ 轮后 fork,新会话第一条消息让 agent 总结"前面我们讨论了什么",验证 L1 完整继承
- 手动验证：fork 工作区中包含未提交修改 → 在新 worktree 中执行 `git status` 应看到相同修改
- 边界测试：non-workspace 场景下 fork 后立即 `setup_workspace`,应正确切换到独立 workspace

## 10. 关键决策表

| 决策 | 选择 | 原因 |
|------|------|------|
| 工作区共享 vs 独立 | workspace 场景独立,non-workspace 共享 | 避免无写操作场景的无谓复制 |
| Fork 入口 | 隐藏命令 `/fork` | 重度功能,避免普通用户误用 |
| 话题结构 | 并列新话题(非嵌套) | 飞书模型限制 |
| 历史范围 | P0 全量继承,P1 支持截断 | 先解决主要痛点 |
| 命名 | `-fork-<id>` 后缀 | 文件系统层即可识别血缘 |
| 未提交修改 | patch + apply | 保留 staged/unstaged/untracked 全部状态 |
