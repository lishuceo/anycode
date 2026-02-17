---
name: review
description: Multi-agent code review for uncommitted changes, latest commit, or a pull request
argument-hint: "[PR number, PR URL, or empty for local changes]"
---

# Review: 多维度并行代码审查

对代码变更进行全面审查，使用多个 agent 并行覆盖不同审查维度。

## 确定审查范围

根据 `$ARGUMENTS` 决定审查目标：

### 无参数时（本地变更）

按优先级选择审查范围：

1. **未提交的变更**（staged + unstaged + untracked）：
   - 运行 `git diff HEAD` 查看 tracked 文件的变更
   - 运行 `git ls-files --others --exclude-standard` 发现 untracked 新文件，将其完整内容也纳入审查
   - 如果有任何变更或新文件，则审查这些内容
2. **最近一次 commit**：如果没有未提交变更，运行 `git diff HEAD~1..HEAD` 审查最近一个 commit

**边界处理**：
- 先运行 `git rev-list --count HEAD 2>/dev/null` 检查 commit 数量
- 如果命令失败（无 commit），提示用户"仓库尚无 commit，无内容可审查"
- 如果只有 1 个 commit 且无未提交变更，用 `git show HEAD` 代替 `git diff HEAD~1..HEAD`

用 `git status` 确认当前状态，告知用户审查的是哪个范围。

### 有参数时（审查 PR）

参数可以是：
- PR 编号：`/review 4` → `gh pr diff 4`，`gh pr view 4`
- PR URL：`/review https://github.com/org/repo/pull/4` → 提取编号后同上

用 `gh pr diff` 获取完整 diff，用 `gh pr view` 了解 PR 意图。

**参数校验**：如果 `$ARGUMENTS` 既不是有效的正整数，也无法从 URL 中提取 PR 编号（格式应为 `https://github.com/{owner}/{repo}/pull/{number}`），则告知用户参数无效并给出正确用法示例：`/review 4` 或 `/review https://github.com/org/repo/pull/4`。

## 多 Agent 并行审查

使用 TeamCreate 创建审查团队，启动 **3 个并行 agent**，每个专注一个维度。

给每个 agent 的共同上下文：
- CLAUDE.md 的内容（项目架构、模式、技术栈）
- 完整的 diff 内容
- 变更涉及的文件列表

### Agent 1: 🔒 安全审查 (security-reviewer)

检查项：
- 命令注入、SQL 注入、XSS 等注入风险
- 密钥/凭据泄露（.env、API key、token 硬编码）
- 不安全的权限配置
- 缺少输入校验（尤其是系统边界：用户输入、外部 API）
- 不安全的依赖使用

### Agent 2: 🐛 逻辑与正确性审查 (logic-reviewer)

检查项：
- 逻辑错误、off-by-one、空值/undefined 访问
- 竞态条件、未处理的 Promise rejection
- 错误处理遗漏或不当（catch 吞异常、错误类型丢失）
- 资源泄漏（未关闭连接、未清理事件监听、定时器泄漏）
- 边界条件和异常路径

### Agent 3: 🏗️ 架构与质量审查 (architecture-reviewer)

检查项：
- 是否符合 CLAUDE.md 中描述的项目模式（ESM `.js` 后缀、单例模式、两阶段消息等）
- TypeScript 类型安全（不安全的 `any`、错误的泛型、async/await 陷阱）
- 模块边界是否清晰，是否有循环依赖
- 命名一致性、代码组织
- 是否过度工程或缺少必要抽象

### 每个 Agent 的输出格式

每个 agent 必须对发现的每个问题标注：

- **严重程度**：🔴 Critical / 🟡 Warning / 🔵 Info
- **置信度**：0-100 分
- **文件和行号**：`path/to/file.ts:42`
- **问题描述**：简洁说明问题
- **建议修复**：给出具体的代码修改建议

**置信度规则**（参考 GitHub Action 标准）：
- 90-100：确定的 bug 或安全问题
- 75-89：高度确信，很可能是真实问题
- 50-74：中等置信，值得提及
- **低于 50 的不报告**（噪音太大）

**误报过滤**（以下情况不报告）：
- PR/变更之前就存在的问题
- 代码风格偏好或 nitpick
- linter/formatter 会自动处理的问题
- 不言自明的代码缺少注释
- 假设性的未来问题
- 代码"可以更好"但当前实现正确

## 汇总审查结果

收集所有 agent 的结果后，汇总成一份报告：

```
## 📋 Code Review 总结

**审查范围**：<描述审查了什么>
**总体评价**：✅ Approved / ⚠️ Issues Found / 🚫 Changes Requested

### 发现问题

#### 🔴 Critical
- [security-reviewer] `path/file.ts:42` — 描述 (置信度: 95)

#### 🟡 Warning
- [logic-reviewer] `path/file.ts:88` — 描述 (置信度: 80)

#### 🔵 Info
- [architecture-reviewer] `path/file.ts:15` — 描述 (置信度: 60)

### 亮点
- <变更中做得好的地方>

### 建议
- <改进建议>
```

**判定标准**：
- 有任何 🔴 Critical → 🚫 Changes Requested
- 只有 🟡 Warning → ⚠️ Issues Found
- 只有 🔵 Info 或无问题 → ✅ Approved

## 注意事项

- 每个 agent 必须 **阅读完整源文件**，不能只看 diff 片段
- 用 `git blame` 和 `git log` 了解变更历史和上下文
- 审查要基于事实，引用具体代码行，不要猜测
- 对每个问题给出可操作的修复建议，不要只说"这不好"
