---
summary: "Per-thread 工作区隔离：防止并发 git 操作冲突"
related_paths:
  - src/workspace/isolation.ts
last_updated: "2026-04-06"
---

# Per-Thread Workspace Isolation

确保每个飞书话题在独立的工作目录中运行，防止并发 git 操作冲突。

## 核心问题

多个 thread 路由到同一个 `use_existing` 目录时（如 `~/projects/myrepo`），并发写入会导致 git 状态冲突。需要自动创建隔离的工作目录副本。

## 隔离逻辑

`ensureIsolatedWorkspace(workingDir, mode)` 的决策树：

```
输入 workingDir
  ↓
已在 WORKSPACE_BASE_DIR 内？ → 返回原路径（已由 clone_remote 隔离）
  ↓
有 .git 目录？
  ├── 是 → setupWorkspace({ localPath }) → 创建隔离 clone
  └── 否 → 返回原路径（非 git 仓库，安全共享）
```

### 隔离 vs 跳过

| 场景 | 行为 |
|------|------|
| Routing 返回 `clone_remote` | 跳过隔离（workspace manager 已创建独立目录） |
| Routing 返回 `use_existing` → 共享源目录 | **触发隔离**，创建新 clone |
| Routing 返回 `use_default` → 非 git 目录 | 跳过隔离（安全共享） |

### 错误处理

| 模式 | clone 失败行为 |
|------|-------------|
| `writable` | 抛异常（不能在共享目录写入） |
| `readonly` | 返回原路径 + warning（只读安全） |

## 辅助函数

- `isAutoWorkspacePath(dir)` — 检查是否在 `WORKSPACE_BASE_DIR` 内（用 `realpathSync` 解析 symlink）
- `isServiceOwnRepo(dir)` — 检查是否为 bridge 服务自身仓库
- `isInsideSourceRepo(path)` — 检查路径是否在 `DEFAULT_WORK_DIR` 下的源仓库工作树内（含子目录）。用于源仓库保护（`canUseTool` 中阻止写操作）。优先使用 registry 缓存的路径集合做前缀匹配，fallback 到向上遍历目录树。详见 `workspace-cache-and-restart.md` 的源仓库保护章节

## 与路由的集成

```
Routing Agent 返回 use_existing
  ↓ workdir = ~/projects/myrepo
thread-context.ts 调用 ensureIsolatedWorkspace()
  ↓ 创建 ~/workspaces/myrepo-writable-abc123
ThreadSession 绑定隔离后的路径
  ↓
后续消息在隔离目录中执行（各 thread 互不干扰）
```

## 文件

- `src/workspace/isolation.ts` (99 行) — `ensureIsolatedWorkspace()`, `isAutoWorkspacePath()`

## 设计决策

| 决策 | 理由 |
|------|------|
| 自动隔离而非手动 | 用户不需要知道隔离细节 |
| 仅 git 仓库触发隔离 | 非 git 目录无并发冲突风险 |
| readonly 降级到原路径 | 只读操作共享目录是安全的 |
| writable 严格隔离 | 并发写入会导致不可预测的 git 状态 |
