# 设计：每个话题独立工作区 (Per-Thread Workspace Isolation)

## 背景

当前架构中，routing agent 在新话题首条消息时决定工作目录。对于 `clone_remote` 决策（用户提供仓库 URL），系统已经会创建隔离工作区。但对于 `use_existing` 决策（本地已有的仓库目录），系统直接在原目录上工作。

这导致一个问题：**同一仓库的多个并行话题会共享同一个工作目录**，产生 git 冲突和文件互相覆盖。

## 方案

**一个话题 = 一个工作区**，规则确定，无条件执行。

### 核心改动

1. **路由后自动隔离**：routing agent 返回 `use_existing` 指向本地 git 仓库时，自动通过 `setupWorkspace({ localPath })` 创建隔离 clone，而非直接使用原目录。

2. **过期工作区清理**：thread session 过期时（30 天不活跃），同步删除其 `workingDir` 指向的自动创建的工作区目录（仅限 `WORKSPACE_BASE_DIR` 下的目录）。

3. **过期工作区检测**：用户在已清理的工作区话题中追问时，提示"工作区已过期"，引导开新话题。不静默重建（重建会导致上下文断裂但表面正常，比明确报错更危险）。

### 磁盘成本

- `git clone --local` 使用硬链接共享 `.git/objects`，额外磁盘开销 ≈ 源码文件大小
- 硬链接安全：git 对象文件 write-once 不可变，删除一个链接不影响另一个
- 30 天定时清理 + 启动时清理残留临时目录

### 哪些路径会被隔离

| 来源 | 原行为 | 新行为 |
|------|--------|--------|
| `clone_remote` (URL) | 已创建隔离工作区 | 不变 |
| `use_existing` (projectsDir 下的 git repo) | 直接使用原目录 | **clone 到新工作区** |
| `use_default` (无特定仓库) | 使用 defaultWorkDir | 不变（非 git repo，不 clone） |
| `/workspace` 命令 | 已创建隔离工作区 | 不变 |
| `/project` 命令 | 直接使用指定目录 | 不变（手动覆盖，不经过路由） |

### 不重建过期工作区的理由

如果用户跟一个已清理的工作区话题继续对话：
- 重新 clone = 干净代码，但 Claude 的 conversation resume 记着之前的修改
- Claude 会基于"我之前改了 X"的假设继续工作，但代码里没有这些改动
- **透明失败 > 静默恢复到错误状态**

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/feishu/event-handler.ts` | 新增 `ensureIsolatedWorkspace()`，路由后调用；新增过期工作区检测 |
| `src/claude/executor.ts` | `mkdirSync` 兜底不再对 `WORKSPACE_BASE_DIR` 下的路径生效 |
| `src/claude/router.ts` | 路由 prompt 移除 `workspacesDir` 查找步骤 |
| `src/session/database.ts` | 新增 `getExpiredThreadSessions()` 方法 |
| `src/session/manager.ts` | `cleanup()` 增加工作区目录删除逻辑 |
