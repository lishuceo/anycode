---
name: ship
description: Commit all changes, push to origin, and create a GitHub pull request
disable-model-invocation: true
argument-hint: "[commit message or description of changes]"
---

# Ship: Commit → Push → Create PR

将当前工作提交、推送并创建 PR，一步到位。

## 步骤

### 1. 分析变更

- 运行 `git status` 和 `git diff` 查看所有变更
- 运行 `git log --oneline -5` 了解提交风格
- 识别哪些文件属于本次变更（排除无关的修改）

### 2. Commit

- 仅 `git add` 与本次变更相关的文件，**不要** `git add .` 或 `git add -A`
- 提交信息遵循项目风格：`<type>: <中文描述>`，type 使用 conventional commits（feat/fix/test/docs/refactor/chore）
- 如果用户通过 `$ARGUMENTS` 提供了描述，以此为基础生成 commit message
- 如果没有提供描述，根据 diff 内容自动生成

### 3. Push

- 如果当前在 `main` 分支，先创建新分支（基于变更内容命名，如 `feat/add-vitest`）
- `git push -u origin <branch>`

### 4. Create PR

- 使用 `gh pr create` 创建 PR
- PR 标题与 commit message 一致（去掉 Co-Authored-By）
- PR body 格式：

```
## Summary
- <变更要点，1-3 条>

## Test plan
- [ ] <测试项>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## 注意事项

- **绝不**提交 `.env`、credentials 等敏感文件
- 如果没有任何变更，告知用户而不是创建空提交
- 每一步都展示结果，出错时停下来说明原因
