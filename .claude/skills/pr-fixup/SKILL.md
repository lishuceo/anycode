---
name: pr-fixup
description: Wait for PR review action to complete, fix valid issues or resolve false positives, loop until PR is clean
argument-hint: "[PR number, default: current branch's PR]"
---

# PR Fixup: Review → Fix/Dispute → Re-review Loop

等待 PR review action 完成，分析 review 评论，修复真实问题或反驳误报，循环直到 PR 无阻塞问题。

## 前置信息收集

1. **获取仓库信息**: `gh repo view --json nameWithOwner -q .nameWithOwner` → 得到 `OWNER/REPO`，再拆分出 OWNER 和 REPO
2. **确定 PR 号**:
   - 如果 `$ARGUMENTS` 提供了 PR 号或 URL（`https://github.com/.../pull/N`），提取编号使用
   - 否则: `gh pr view --json number -q .number` 自动检测当前分支 PR
   - 如果没有 PR，告知用户并停止
3. **获取当前分支**: `git branch --show-current`
4. **读取 PR 信息**: `gh pr view PR_NUMBER` 了解 PR 意图

## 主循环

重复以下步骤，直到所有 review 问题解决。**最多 5 轮**，超过后提醒用户手动介入。

---

### Step 1: 等待 Review Action 完成

先获取 PR 最新 commit SHA：

```bash
gh pr view PR_NUMBER --json headRefOid -q .headRefOid
```

然后轮询检查该 commit 对应的 pr-review workflow 运行状态：

```bash
gh run list --workflow=pr-review.yml -b BRANCH -L 5 --json status,conclusion,databaseId,headSha
```

从结果中筛选 `headSha` 匹配最新 commit 的运行。

- 如果**没有匹配的运行**，等待 30 秒后重试（action 可能还没触发）
- 如果 `status` 不是 `"completed"`，每 30 秒轮询一次，最多等待 20 分钟
- 如果 `conclusion` 是 `"failure"`，用 `gh run view ID --log-failed` 查看失败原因，告知用户并停止
- 如果 `conclusion` 是 `"success"`，继续下一步

### Step 2: 获取未解决的 Review 评论

通过 GraphQL 获取所有 review threads：

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
- 发起评论（第一条 comment）的 `author.login` 是 `claude[bot]`

如果**没有未解决的 claude[bot] 评论** → 输出 "✅ PR review 通过，无阻塞问题" 并结束循环。

### Step 3: 分析每个评论

对于每个未解决的评论：

1. **读取完整源文件**：用 Read 工具读取评论所在的 `path` 文件
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

### Step 4: 处理问题

**对于真实问题：**
- 修复代码，使用最小改动，不做不相关的重构
- `git add` 修改的文件

**对于误报：**

1. 回复评论说明原因：

```bash
gh api repos/OWNER/REPO/pulls/PR_NUMBER/comments/COMMENT_DATABASE_ID/replies \
  -f body="Not an issue — <具体解释，引用代码说明 reviewer 的判断为什么不适用于此场景>"
```

2. Resolve 该 thread：

```bash
gh api graphql -f query='mutation {
  resolveReviewThread(input:{threadId:"THREAD_NODE_ID"}) {
    thread { isResolved }
  }
}'
```

### Step 5: 提交推送或结束

统计本轮处理结果。

**如果有代码修复：**
- `git commit`，message 遵循项目风格: `fix: address PR review feedback`（如果能更具体则写具体内容，如 `fix: 修复 session cleanup 竞态条件`）
- `git push`
- 输出 "🔄 第 N 轮：修复 X 个问题，反驳 Y 个误报，等待新一轮 review..."
- 回到 Step 1

**如果只有误报被 resolve（无代码修复）：**
- 输出 "✅ 第 N 轮：反驳 Y 个误报并 resolve，PR review 通过"
- 结束循环

---

## 完成汇总

循环结束时，输出汇总报告：

```
## 📋 PR Fixup 完成

- **总轮数**: N
- **修复问题**: X 个
- **反驳误报**: Y 个
- **PR 状态**: ✅ 无阻塞问题
```

## 注意事项

- 只处理 `claude[bot]` 的评论，不处理人类 reviewer 的评论
- 反驳评论时给出**具体、有理据的解释**，引用代码上下文，不要笼统地说"这没问题"
- commit message 遵循项目风格: `fix: <中文描述>`
- 如果同一个问题反复出现（修了又被报），在第 3 轮后停下来让用户介入
