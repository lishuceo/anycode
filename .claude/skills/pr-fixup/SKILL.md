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

## 主循环

重复以下步骤，直到所有 CI checks 通过且 review 问题解决。**最多 5 轮**，超过后提醒用户手动介入。

---

### Step 1: 等待所有 CI checks 完成

轮询 PR 的所有 status checks：

```bash
gh pr checks PR_NUMBER --json name,state,description,link
```

**注意**: 如果 `gh pr checks` 不支持 `--json`，改用：

```bash
gh pr checks PR_NUMBER
```

输出格式为 `NAME\tSTATUS\tDURATION\tLINK`，其中 STATUS 为 pass/fail/pending。

轮询逻辑：
- 如果有任何 check 状态为 `pending`（或 `in_progress`），**等待 60 秒后重试**，最多等待 20 分钟
- 当所有 checks 都完成后（无 pending），进入下一步判断

**重要：轮询时不要使用 `sleep` 命令等待，改用 Bash 的 `timeout` 参数设置超时：**

```bash
# 错误：会导致空闲超时
sleep 60

# 正确：在单个命令中完成等待和检查
for i in $(seq 1 20); do
  result=$(gh pr checks PR_NUMBER 2>&1)
  if echo "$result" | grep -q "pending"; then
    echo "Attempt $i: still pending, waiting 60s..."
    # 使用子命令内联等待，保持输出活跃
    for j in $(seq 1 6); do sleep 10 && echo "  ...waiting ($((j*10))s)"; done
  else
    echo "$result"
    break
  fi
done
```

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

如果没有 CI 失败（Step 2 已全部通过）且没有未解决的 `claude[bot]` 评论 → 输出 "✅ 所有 CI checks 通过，PR review 无阻塞问题" 并结束循环。

### Step 4: 分析并处理 Review 评论

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

统计本轮处理结果（CI 修复数 + review 修复数 + 误报反驳数）。

**如果有代码修复（CI 修复或 review 修复）：**
- `git commit`，message 遵循项目风格，如：
  - `fix: 修复 CI 构建错误` (CI 问题)
  - `fix: address PR review feedback` (review 问题)
  - `fix: 修复 CI 构建错误并处理 review 反馈` (两者都有)
- `git push`
- 输出 "🔄 第 N 轮：修复 X 个 CI 问题 + Y 个 review 问题，反驳 Z 个误报，等待新一轮 checks..."
- 回到 Step 1

**如果只有误报被 resolve（无代码修复）且 CI 全部通过：**
- 输出 "✅ 第 N 轮：反驳 Y 个误报并 resolve，所有 CI checks 通过"
- 结束循环

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

- 只处理 `claude[bot]` 的评论，不处理人类 reviewer 的评论
- 反驳评论时给出**具体、有理据的解释**，引用代码上下文，不要笼统地说"这没问题"
- commit message 遵循项目风格: `fix: <中文描述>`
- 如果同一个问题反复出现（修了又被报），在第 3 轮后停下来让用户介入
- **不要使用裸 `sleep` 命令** — 长时间 sleep 会导致 SDK 空闲超时。轮询等待时在循环中保持输出活跃
- 如果 CI 失败是环境/平台问题（非代码可修复），明确告知用户而不是反复重试
