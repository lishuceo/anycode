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

### 3. 文档健康检查

在 push 前，检查本次变更是否需要同步更新文档：

#### 3a. 关联设计文档检查

扫描 `docs/design/` 下所有 `.md` 文件的 YAML front matter 中的 `related_paths`。
如果本次变更的文件匹配了某个设计文档的 `related_paths`，提醒用户该设计文档可能需要更新。

#### 3b. Plan 状态检查

扫描 `docs/plans/` 下的 `.md` 文件：
- 如果变更涉及某个 plan 的 `related_paths`，检查该 plan 的 `status` 和 `last_updated` 是否需要更新
- 如果 plan 的功能已全部实现，提醒用户将 status 改为 `completed`

#### 3c. CLAUDE.md 一致性

检查 `CLAUDE.md` 中引用的路径是否仍然有效，以及本次变更是否引入了 CLAUDE.md 应记录但未记录的内容（新目录、新工具、新工作流）。

#### 3d. 用户指南检查

如果变更修改了用户可见的行为（CLI 参数、API 行为、协议格式等），检查 `docs/guides/` 下是否有对应文档需要同步。

**处理方式**：
- 发现需要更新的文档时，**列出清单并询问用户**是否需要现在更新
- 用户确认后执行更新，然后追加 commit
- 用户选择跳过则继续 push

### 4. Push

- 如果当前在 `main` 分支，先创建新分支（基于变更内容命名，如 `feat/add-vitest`）
- `git push -u origin <branch>`

### 5. Create PR

- 使用 `gh pr create` 创建 PR
- PR 标题与 commit message 一致（去掉 Co-Authored-By）
- PR body 格式：

```
## 变更概述
- <变更要点，1-3 条>

## 测试计划
- [ ] <测试项>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## 注意事项

- **绝不**提交 `.env`、credentials 等敏感文件
- 如果没有任何变更，告知用户而不是创建空提交
- 每一步都展示结果，出错时停下来说明原因
- PR 创建成功后，提示用户：可以运行 `/pr-fixup` 自动等待 review 并修复问题
