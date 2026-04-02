---
summary: "Bare clone 缓存层 + workspace 隔离 + Agent restart 机制"
related_paths:
  - src/workspace/**
last_updated: "2026-04-02"
---

# Workspace 架构

仓库缓存、工作区创建和 Git 安全控制。

## Bare Clone 缓存（cache.ts）

远程仓库通过 bare clone 缓存到本地，避免重复 clone。

### 缓存路径格式

`repoUrlToCachePath()` 将 URL 归一化为 `host/org/repo.git`（全小写）：

```
https://github.com/foo/bar.git  → github.com/foo/bar.git
git@github.com:foo/bar.git     → github.com/foo/bar.git
ssh://git@host/foo/bar.git     → host/foo/bar.git
```

**安全检查**：resolve() 验证 + 阻止 `..`、空段、`.` 前缀段。

### 缓存流程

`ensureBareCache(repoUrl)`:
1. 计算缓存路径
2. **已存在** → `fetchIfStale()` 更新（间隔由 `config.repoCache.fetchIntervalMin` 控制）
3. **不存在** → `cloneBareAtomic()`：创建 `.tmp-{randomHex}` 临时目录 → clone → rename（原子操作）
4. Fetch 失败 → 非阻塞，返回 `fetchFailed: true` 使用 stale cache

### 启动清理

`cleanupTmpDirs()` 在服务启动时清理 `.tmp-*` 残留。

## Workspace Manager（manager.ts）

从缓存创建实际工作目录。

### 两种模式

| 模式 | 行为 |
|------|------|
| `writable` | 从 bare cache local clone → 设置 remote origin → 创建 feature branch `{branchPrefix}-{shortId}` |
| `readonly` | 从 bare cache local clone → 可选 `--branch sourceBranch` → 不创建分支 |

**目录命名**：`{repoName}-{writable|readonly}-{shortId}`，位于 `WORKSPACE_BASE_DIR`。

### 输入/输出

```typescript
interface SetupWorkspaceOptions {
  repoUrl?: string;        // 远程仓库（与 localPath 二选一）
  localPath?: string;      // 本地仓库
  mode?: 'readonly' | 'writable';
  sourceBranch?: string;
  featureBranch?: string;  // 自定义分支名
}

interface SetupWorkspaceResult {
  workspacePath: string;   // 绝对路径
  branch: string;          // 分支名
  repoName: string;
  warning?: string;        // fetch 失败等非阻塞警告
}
```

## Git 安全（git-security.ts）

所有 git 命令携带安全参数：

| 参数集 | 内容 | 用途 |
|--------|------|------|
| `GIT_REMOTE_CLONE_ARGS` | 禁 hooks + 禁 submodules + 禁 file:// | 远程 clone（防 SSRF） |
| `GIT_REMOTE_FETCH_*` | 禁 hooks + 禁 file:// | 远程 fetch |
| `GIT_LOCAL_CLONE_ARGS` | 禁 hooks + 禁 submodules | 本地 clone（允许 file://） |

## Repo Identity（identity.ts）

将任意工作目录映射到规范的仓库标识，供记忆系统隔离使用：

```
~/workspaces/myrepo-writable-abc123/  →  github.com/org/myrepo.git
~/projects/myrepo/                     →  github.com/org/myrepo.git  (通过 git remote 解析)
```

解析顺序：bare cache 路径 → remote URL 归一化 → symlink 追踪（最多 3 跳） → 目录路径兜底。结果缓存。

## 文件结构

```
src/workspace/
  cache.ts          # Bare clone 缓存层
  manager.ts        # 工作区创建（writable/readonly）
  isolation.ts      # Per-thread 工作区隔离（见 design-per-thread-workspace.md）
  git-security.ts   # Git 命令安全参数
  identity.ts       # 仓库标识归一化
  tool.ts           # setup_workspace MCP 工具
```

## 设计决策

| 决策 | 理由 |
|------|------|
| Bare clone 缓存 | 节省带宽和时间，多个工作区共享同一个缓存 |
| 原子创建（tmp+rename） | 防止 clone 中断留下半成品目录 |
| Fetch 失败非阻塞 | 网络问题不应阻止使用已有缓存 |
| 禁 hooks/submodules | 防止恶意仓库通过 hook 执行代码 |
| 禁 file:// 协议（远程） | 防止 SSRF 攻击 |
