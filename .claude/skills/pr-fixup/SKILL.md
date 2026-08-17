---
name: pr-fixup
description: Wait for ALL CI checks and PR review to complete, fix CI failures and review issues, loop until PR is clean
argument-hint: "[PR number, default: current branch's PR]"
---

# PR Fixup: CI + Review → Fix → Re-run Loop

等待所有 CI checks 和 PR review 完成，修复 CI 构建/测试失败和 review 评论问题，循环直到 PR 全部通过。

## 前置信息收集

1. **获取仓库信息**: `gh repo view --json nameWithOwner -q .nameWithOwner` → 得到 `OWNER/REPO`，再拆分出 OWNER 和 REPO
2. **确定 PR 号**:
   - 如果 `$ARGUMENTS` 提供了 PR 号或 URL（`https://github.com/.../pull/N`），提取编号使用
   - 否则: `gh pr view --json number -q .number` 自动检测当前分支 PR
   - 如果没有 PR，告知用户并停止
3. **获取当前分支**: `git branch --show-current`
4. **读取 PR 信息**: `gh pr view PR_NUMBER` 了解 PR 意图

## 主循环（cron 驱动，非阻塞）

重复以下步骤，直到所有 CI checks 通过且 review 问题解决。**最多 5 轮**，超过后提醒用户手动介入。

**关键：等待 CI 绝不原地阻塞轮询。** 阻塞轮询（`for` 循环里反复 `gh pr checks` + 内联 `sleep`/`echo`）会把每隔几秒的进度行不断回灌进上下文，单轮数分钟 × 多轮极度浪费 token；且本平台一旦返回结果，子进程（含后台任务 / Monitor）就被回收，无法跨轮等待。改用「**单次检查 + cron 一次性回检**」把循环异步化：每次进入（用户首次调用或 cron 触发）只做一次状态检查 + 一轮力所能及的修复；需要等 CI 时排一个 cron 一次性任务在预计完成后自动回来，并**立即结束本轮**、让出会话。轮次计数 N 由 cron 回检 prompt 携带（每排一次 +1），到第 5 轮仍未干净则停下提醒用户。

---

### Step 0: 检查 Merge 冲突

每轮开始前先检查 PR 是否有 merge 冲突：

```bash
gh pr view PR_NUMBER --json mergeable,mergeStateStatus -q '{mergeable: .mergeable, state: .mergeStateStatus}'
```

**判断逻辑（需同时检查两个字段）：**

| 条件 | 处理 |
|------|------|
| `mergeable=MERGEABLE` 且 `state=CLEAN` | 无冲突且最新，继续下一步 |
| `mergeable=MERGEABLE` 且 `state=BEHIND` | 分支落后 base，需要 rebase 更新 |
| `mergeable=CONFLICTING` | 有冲突，尝试自动 rebase |
| `mergeable=UNKNOWN` | GitHub 还在计算，等待 10 秒后重查（最多 3 次） |

**重要**：`BEHIND` 状态表示分支可以合并但落后于 base branch。如果仓库有 "require branches to be up to date" 规则，必须 rebase 才能合并。即使没有此规则，也建议 rebase 以确保 CI 基于最新代码运行。

**自动 rebase 流程：**

1. 确定 base branch：`gh pr view PR_NUMBER --json baseRefName -q .baseRefName`
2. 执行 rebase：
```bash
git fetch origin BASE_BRANCH
git rebase origin/BASE_BRANCH
```
3. 如果 rebase **成功**（无冲突）：
   - `git push --force-with-lease` 更新 PR
   - 按 Step 1 的「排定回检」排一个 cron 一次性回检（rebase 触发了新一轮 CI），输出 "🔄 已自动 rebase，已排定约 4 分钟后回检新一轮 CI"，然后**结束本轮**
4. 如果 rebase **失败**（有无法自动解决的冲突）：
   - `git rebase --abort` 取消
   - 输出冲突文件列表，提示用户手动解决
   - **停止循环**，不要尝试自动合并冲突

### Step 1: 检查 CI 状态（单次检查 + cron 回检，不阻塞）

**一次性**查询所有 status checks（不要放进等待循环）：

```bash
gh pr checks PR_NUMBER 2>&1
```

输出 `NAME\tSTATUS\tDURATION\tLINK`，STATUS 为 pass/fail/pending/skipping（`gh pr checks` 退出码：全 pass=0、有 pending=8、有 fail≠0，可参考，但以文本为准）。

判断：

- **仍有 `pending`/`in_progress`** → **排 cron 一次性回检后立即结束本轮**（见下「排定回检」），不要原地等待。
- **无 pending**（全部 pass/fail/skipping，`skipping` 不算阻塞）→ 进入 Step 2。

**排定回检（用 cron 调度工具，如 `manage_cron`）：**

1. 估算回检时间：一般 `+4 分钟`；若 pending 的是外部 AI review（如 Greptile，常需 5-7 分钟）取 `+5 分钟`。算出绝对时间：

```bash
date -d "+4 minutes" "+%Y-%m-%dT%H:%M:%S"
```

2. 创建一次性任务（`manage_cron`）：
   - `action: "add"`、`schedule_kind: "at"`、`at: "<上一步算出的时间>"`
   - `name: "pr-fixup-recheck-<PR_NUMBER>"`
   - `prompt:` 必须自包含、能让回检回合从头跑通本流程并携带轮次 N，例如：
     `"[后台定时回检] 请重新调用 pr-fixup 技能继续处理 PR #<PR_NUMBER>（<OWNER/REPO>），这是第 <N> 轮 CI 回检：若 CI 仍 pending 就再排一次回检；若已完成则处理 CI 失败与 review 反馈、修复推送后再排回检；若全部通过且无未解决反馈则输出完成汇总并停止；已是第 5 轮仍未干净则停下提醒用户手动介入。"`

3. 给用户输出一行状态后**结束本次回复**（不要继续等待）：
   `⏳ CI 运行中（<n> 项 pending），已排定约 4 分钟后自动回检（第 N 轮），先让出会话。`

> **为什么用 cron 而非阻塞轮询 / Monitor**：阻塞轮询每隔几秒回灌进度行、单轮数分钟 × 多轮，极费 token；而本平台一旦返回结果，子进程（含 Monitor 和后台任务）即被回收，Monitor 无法跨越 5 分钟以上的等待。cron 一次性任务每次 fire 都是一个廉价的新回合，只做一次状态检查，零轮询回灌。

### Step 2: 检查 CI 失败

检查 Step 1 的结果，将 checks 分为三类：

| 类别 | 处理方式 |
|------|----------|
| **CI 构建/测试失败** (如 build, test, lint, typecheck) | 获取失败日志 → 修复代码 |
| **Review 失败** (如 review, pr-review) | 进入 Step 3 处理评论 |
| **全部通过** | 进入 Step 3 检查评论（可能有 review 评论但 check 显示 pass） |

**对于 CI 构建/测试失败：**

1. 识别失败的 workflow run：

```bash
gh run list -b BRANCH -L 5 --json databaseId,name,conclusion,headSha,workflowName
```

找到 `conclusion` 为 `"failure"` 且 `headSha` 匹配最新 commit 的 run。

2. 获取失败日志：

```bash
gh run view RUN_ID --log-failed 2>&1 | tail -100
```

如果日志太长，取最后 100 行，重点关注 error/Error/FAILED 等关键行。

3. 分析日志，定位失败原因（编译错误、测试失败、lint 问题等）。

4. **修复代码** — 根据错误日志修复问题，使用最小改动。

5. 如果是**环境/平台问题**（如 macOS-only 依赖在 Linux CI 上不可用、系统库缺失等非代码问题），无法通过修改代码解决，向用户说明情况并建议：
   - 修改 CI 配置跳过该平台
   - 添加条件编译/构建
   - 或手动处理

6. `git add` 修改的文件，**不要立即 commit** — 在 Step 5 统一处理。

### Step 3: 获取未解决的 Review 评论

Review 反馈分布在三个地方，必须**都检查**，不能只看 inline review threads：

1. **Inline review threads** — reviewer 在具体代码行上的评论（GraphQL `reviewThreads`）
2. **PR 顶层 issue comments** — review bot 经常把发现的问题汇总成一条整体评论发到 PR 主时间线（`gh pr view --json comments`）
3. **PR description** — 部分 review bot 会把 summary 写进 PR description 而非 comment

先获取 PR 作者、body、head SHA，以及最后一次推送对应的 commit 时间：

```bash
gh pr view PR_NUMBER --json author,body,headRefOid -q '{author: .author.login, body: .body, sha: .headRefOid}'
# 用 GitHub 上 head commit 的 committer date 作为"最后一次 push 时间"的近似值
# 不要用本地 git log（rebase/amend 后本地时间和 GitHub 上不一致）
HEAD_SHA=$(gh pr view PR_NUMBER --json headRefOid -q .headRefOid)
LAST_PUSH=$(gh api repos/OWNER/REPO/commits/$HEAD_SHA --jq .commit.committer.date)
```

**3a. Inline review threads**（GraphQL）：

```bash
gh api graphql -f query='{
  repository(owner:"OWNER", name:"REPO") {
    pullRequest(number:PR_NUMBER) {
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          comments(first:10) {
            nodes {
              databaseId
              body
              author { login }
              path
              line
              createdAt
            }
          }
        }
      }
    }
  }
}'
```

过滤条件：
- `isResolved == false`（未解决）
- 第一条 comment 的 `author.login` **不是** PR 作者

**3b. PR 顶层 issue comments**：

```bash
gh pr view PR_NUMBER --json comments -q '.comments[] | select(.author.login != "PR_AUTHOR") | {id, body, author: .author.login, createdAt}'
```

过滤条件：
- `author.login` 不是 PR 作者
- `createdAt` 在最后一次 push 之后（处理新增反馈，忽略已被旧 commit 处理的历史评论）

**3c. PR description**：

检查 PR body 中是否包含 review summary。判定标准（避免把普通 PR 说明误判为 review）：

- **强信号**（出现任一即可判定）：`## Review Summary`、`### Issues Found`、`## Review Notes`、`Suggested Action`
- **弱信号**（需同时出现 ≥2 个才算）：`🟡`、`🔴`、`nit`、`confidence`、`severity`

满足上述任一规则的，把 review summary 段落里的条目当作待处理 review feedback，与 3a/3b 一起进入 Step 4。

**去重（重要）**：3a 靠 `isResolved` 去重、3b 靠 `createdAt > LAST_PUSH` 去重，但 PR description 是静态的，Claude 修完代码 push 后 description 内容并不会变。为避免同一 `/pr-fixup` 调用内同一条 3c 条目被反复处理，必须做以下两件事之一：

- **本轮内存记录**：在当前 `/pr-fixup` 执行流程中维护一个集合（如条目正文的前 50 字符 hash），处理过的 3c 条目下一轮直接跳过
- **镜像到顶层 comment**：处理完 3c 条目后调用 `gh pr comment` 写一条 "Addressed (3c): <条目摘要>" 到 PR 主时间线，让后续轮次靠 3b 的 `LAST_PUSH` 过滤自动跳过

**cron 模式下推荐第二种（镜像到顶层 comment）**：cron 每次回检都是全新回合，「本轮内存记录」无法跨回合保留，只有写到 PR 时间线才能让后续回合靠 3b 的 `LAST_PUSH` 过滤自动跳过。仅当在同一回合内同步处理完所有 3c 条目时才用第一种。

如果没有 CI 失败（Step 2 已全部通过）且 3a/3b/3c 都没有未处理的反馈 → 输出 "✅ 所有 CI checks 通过，PR review 无阻塞问题" 并结束循环。

### Step 4: 分析并处理 Review 评论

对于每个未解决的评论（来自 3a inline、3b issue comment、3c PR description summary）：

1. **读取相关源文件**：
   - inline 评论：用 Read 工具读取评论所在的 `path` 文件
   - issue comment / PR description summary：从 body 中解析出涉及的文件路径（通常是 `src/foo.ts:123` 格式），逐个 Read
2. **理解评论内容**：仔细阅读 `body` 中指出的具体问题
3. **结合上下文判断**：评论是否正确？

分类标准：

| 分类 | 条件 | 举例 |
|------|------|------|
| **真实问题** | 代码确实存在 reviewer 描述的缺陷 | 逻辑错误、安全漏洞、资源泄漏、类型不安全 |
| **误报** | 代码是正确的，reviewer 的分析有误 | 忽略了上下文、误解了控制流、不了解框架行为、过度保守 |

**判断原则**：
- 如果你不确定，**倾向于修复**而不是反驳——宁可多修一个不必要的问题，也不要放过一个真实 bug
- 反驳误报时必须有**明确的理由**，能指出 reviewer 具体哪里判断错了

**对于真实问题：**
- 修复代码，使用最小改动，不做不相关的重构
- `git add` 修改的文件
- 回复评论确认修复：

```bash
# inline review comment（来自 3a）
gh api repos/OWNER/REPO/pulls/PR_NUMBER/comments/COMMENT_DATABASE_ID/replies \
  -f body="Fixed — <简述修改内容>"

# PR 顶层 issue comment（来自 3b）— 没有 thread，直接在 PR 主时间线新增一条
# 回复链接用完整 URL（GitHub 不会把 #COMMENT_ID 解析成 comment 跳转）
gh pr comment PR_NUMBER --body "Fixed — <简述修改内容>（回复 [评论](https://github.com/OWNER/REPO/pull/PR_NUMBER#issuecomment-ISSUE_COMMENT_ID)）"

# PR description summary 条目（来自 3c）— 同样在 PR 主时间线回复
gh pr comment PR_NUMBER --body "Addressed — <简述修改内容>"
```

- Resolve 该 thread（仅 inline review thread 适用，issue comment 和 description summary 无 thread 可 resolve）：

```bash
gh api graphql -f query='mutation {
  resolveReviewThread(input:{threadId:"THREAD_NODE_ID"}) {
    thread { isResolved }
  }
}'
```

**对于误报：**

1. 回复评论说明原因：

```bash
# inline review comment（来自 3a）
gh api repos/OWNER/REPO/pulls/PR_NUMBER/comments/COMMENT_DATABASE_ID/replies \
  -f body="Not an issue — <具体解释，引用代码说明 reviewer 的判断为什么不适用于此场景>"

# PR 顶层 issue comment / description summary（来自 3b/3c）
gh pr comment PR_NUMBER --body "Not an issue — <具体解释>"
```

2. Resolve 该 thread（仅 inline review thread 适用）：

```bash
gh api graphql -f query='mutation {
  resolveReviewThread(input:{threadId:"THREAD_NODE_ID"}) {
    thread { isResolved }
  }
}'
```

### Step 5: 提交推送或结束

统计本轮处理结果（CI 修复数 + review 修复数 + 误报反驳数）。

**如果有代码修复（CI 修复或 review 修复）：**
- `git commit`，message 遵循项目风格，如：
  - `fix: 修复 CI 构建错误` (CI 问题)
  - `fix: address PR review feedback` (review 问题)
  - `fix: 修复 CI 构建错误并处理 review 反馈` (两者都有)
- `git push`
- 按 Step 1 的「排定回检」排一个 cron 一次性回检（轮次 +1），输出 "🔄 第 N 轮：修复 X 个 CI + Y 个 review，反驳 Z 个误报，已排定约 4 分钟后回检新一轮 CI"，然后**结束本轮**（不要原地等待新 CI）

**如果本轮所有 review 反馈都已处理（inline 已 reply+resolve、3b/3c 已 reply）且无代码修复且 CI 全部通过：**
- 输出 "✅ 第 N 轮：处理 Y 个 review 反馈（含 Z 个反驳），所有 CI checks 通过"
- 结束循环

> 注意：3b/3c 没有 thread 可以 resolve，"已处理"的标准是已经发出 `gh pr comment` 回复。不要因为"没有 resolve 动作"就误判为未处理而陷入死循环。

---

## 完成汇总

循环结束时，输出汇总报告：

```
## 📋 PR Fixup 完成

- **总轮数**: N
- **CI 修复**: X 个
- **Review 修复**: Y 个
- **反驳误报**: Z 个
- **PR 状态**: ✅ 所有 checks 通过，无阻塞问题
```

## 注意事项

- 处理所有非 PR 作者的未解决评论（包括 bot 和人类 reviewer）
- 反驳评论时给出**具体、有理据的解释**，引用代码上下文，不要笼统地说"这没问题"
- commit message 遵循项目风格: `fix: <中文描述>`
- 如果同一个问题反复出现（修了又被报），在第 3 轮后停下来让用户介入
- **等 CI 用 cron 一次性回检，不要阻塞轮询、不要裸 `sleep`** — 阻塞轮询费 token，且本平台返回后子进程被回收无法跨轮等待。每次只查一次状态，pending 就排 cron 回检并结束本轮（见 Step 1）
- 如果 CI 失败是环境/平台问题（非代码可修复），明确告知用户而不是反复重试
