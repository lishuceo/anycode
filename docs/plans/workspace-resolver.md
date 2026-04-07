---
summary: "引入 workspace resolver 层：仓库 registry + DEFAULT_WORK_DIR 源仓库保护 + restart 后精简 system prompt"
status: completed
owner: unclee
last_updated: "2026-04-06"
read_when:
  - 修改 workspace 路由逻辑
  - 修改 setup_workspace 工具
  - 修改 canUseTool 权限检查
  - 修改 system prompt 构建逻辑
---

# Workspace Resolver：确定性仓库路由 + 源仓库保护

## 背景

当前 workspace 选择完全依赖 LLM 在运行时通过 `setup_workspace` 工具自行判断，存在两个风险：

1. **选错仓库** — `DEFAULT_WORK_DIR` 下有多个仓库，LLM 可能判断错误
2. **跳过隔离** — LLM 可能直接在 `DEFAULT_WORK_DIR` 下的源仓库 `cd` 进去就开干，绕过 bare cache → 隔离 clone 的标准流程

## 设计目标

1. **源仓库保护**：`DEFAULT_WORK_DIR` 下的源仓库代码只读，但允许 git 维护操作（pull/fetch/checkout 等）
2. **默认走 bare cache**：一旦确定目标仓库，默认从 `.repo-cache` clone 隔离工作区，除非用户明确要求直接在源仓库修改
3. **仓库 registry**：建立可自更新的仓库索引，帮助 LLM 准确匹配模糊的用户请求
4. **restart 后精简 prompt**：workspace 切换后的 session 不再注入全局仓库列表，减少 token 浪费
5. **模糊时主动询问**：LLM 无法确定仓库时应明确询问用户，而不是瞎猜

## 整体架构

```
用户消息 → resolveThreadContext → executor (phase 1, cwd=DEFAULT_WORK_DIR)
                                      ↓
                              LLM 读 .repo-registry.md 判断仓库
                                      ↓
                              ┌─ 明确匹配 → setup_workspace (从 bare cache clone)
                              ├─ 模糊 → 询问用户 → 用户回答后更新 registry
                              └─ 用户说"直接在 X 目录改" → setup_workspace(local_path=X)
                                      ↓
                              executor (phase 2, cwd=隔离工作区, 精简 prompt)
```

## 实施计划

### Phase 0: DEFAULT_WORK_DIR 自动推导

**改动**：`src/config.ts:85`

当前默认值是硬编码的 `/home/ubuntu/projects`，需要用户手动在 `.env` 中配置。改为自动推导：

```typescript
// 旧
defaultWorkDir: process.env.DEFAULT_WORK_DIR || '/home/ubuntu/projects',

// 新：默认为 anywhere-code 仓库的父目录（即 process.cwd() 的上一级）
// 用户仍可通过 DEFAULT_WORK_DIR 环境变量覆盖
defaultWorkDir: process.env.DEFAULT_WORK_DIR || path.dirname(process.cwd()),
```

**逻辑**：anywhere-code 仓库本身一定在 DEFAULT_WORK_DIR 下（自改自需求），所以 `dirname(cwd)` 是合理的默认值。同时 `.repo-cache` 中也应默认有自己的 bare clone（由 Phase 1 的 `ensureBareCacheForLocal` 保证）。

**附带改动**：`.env.example` 中 `DEFAULT_WORK_DIR` 注释掉并标注"通常无需配置"，默认即可正常工作。

**文件改动清单：**

| 文件 | 改动 |
|------|------|
| `src/config.ts` | `defaultWorkDir` 默认值改为 `path.dirname(process.cwd())` |
| `.env.example` | 更新 `DEFAULT_WORK_DIR` 注释 |

### Phase 1: 仓库 Registry 系统

**新建 `src/workspace/registry.ts`**

仓库 registry 使用 JSON 格式（`DEFAULT_WORK_DIR/.repo-registry.json`），由代码维护。同时生成一份 Markdown 渲染（`DEFAULT_WORK_DIR/.repo-registry.md`）供 LLM 按需读取（不注入 system prompt，避免 cache miss）。

JSON 作为 source of truth 的原因：
- 避免并发写入时 Markdown 解析错乱（多个 chat 同时触发 setup_workspace / update_repo_registry）
- 程序化读写可靠，后续加 deterministic matcher 时直接读 JSON
- 写入时使用 atomic write（tmp + rename），防止部分写入
- Markdown 文件在每次 JSON 变更后重新生成，LLM 读取体验不变

#### Registry 主键设计

**主键使用 canonical repo URL**（如 `https://github.com/org/repo`），而非 repo name。

- repo name 不唯一（多个 org 下可能有同名的 `api`、`frontend` 等）
- 同一仓库可能同时在 DEFAULT_WORK_DIR 和 .repo-cache 中存在，需要统一标识
- repo name 作为 alias/显示名，不作为唯一标识

**Canonical URL 规范化**：统一为 `https://{host}/{org}/{repo}` 格式（去掉 `.git` 后缀、auth 信息、协议差异）。复用 `cache.ts` 中 `repoUrlToCachePath()` 的 URL 解析逻辑来标准化。

**本地仓库（无 remote）的处理**：
- 扫描时检测 `git remote get-url origin`，如果没有 remote 则标记为 `local-only`
- 主键使用 `local://{绝对路径}` 格式（如 `local:///root/dev/my-local-project`）
- 这类仓库不适合 bare cache，`setup_workspace` 只能走 `localPath` 模式
- registry 中标记 `缓存: (本地仓库，无 remote)`

**JSON 格式示例** (`.repo-registry.json`)：

```json
{
  "repos": {
    "https://github.com/user/anywhere-code": {
      "name": "anywhere-code",
      "localPath": "./anywhere-code",
      "cachePath": ".repo-cache/github.com/user/anywhere-code.git",
      "description": "Feishu ↔ Claude Code bridge，多 agent 开发系统",
      "keywords": ["feishu", "claude", "agent", "bridge", "mcp", "飞书"],
      "techStack": ["TypeScript", "Node.js", "Express"]
    },
    "https://github.com/org/project-b": {
      "name": "project-b",
      "localPath": null,
      "cachePath": ".repo-cache/github.com/org/project-b.git",
      "description": null,
      "keywords": [],
      "techStack": []
    },
    "local:///root/dev/my-local-project": {
      "name": "my-local-project",
      "localPath": "./my-local-project",
      "cachePath": null,
      "description": null,
      "keywords": [],
      "techStack": []
    }
  }
}
```

**Markdown 渲染** (`.repo-registry.md`)：从 JSON 自动生成，供 LLM 阅读。格式与之前设计的 Markdown 相同。每次 JSON 变更后同步重新生成。

**实现内容：**

1. `scanAndSyncRegistry()` — 全量扫描函数
   - 扫描 `DEFAULT_WORK_DIR` 下**直接子目录**（排除 `.` 开头的目录，如 `.repo-cache`、`.workspaces`），提取 canonical URL（从 `git remote get-url origin`，使用 git security args）；无 remote 的用 `local://` 格式。对返回的 URL 调用 `sanitizeRepoUrl()` 去除 auth 信息
   - 扫描 `.repo-cache`（`config.repoCache.dir`）下所有 bare clone，从路径推导 canonical URL（`host/org/repo.git` → `https://host/org/repo`）
   - 以 canonical URL 为主键合并：同一 URL 的本地目录和 cache 关联到同一条目
   - 读取现有 JSON registry 并合并：新仓库追加条目（描述/关键词留空），已删除的仓库标记为 removed，已有条目保留人工/LLM 补充的描述和关键词
   - 写入时使用 atomic write（`writeFileSync` to tmp → `renameSync`），然后重新生成 Markdown
   - 扫描完成后，将所有源仓库根路径缓存到内存 `Set<string>`，供 `isInsideSourceRepo()` 使用（避免每次工具调用遍历目录树）
   - **触发时机**：
     - 服务启动时异步调用（`src/index.ts`），不阻塞请求处理。扫描完成前 registry 可能不完整，但 `isInsideSourceRepo()` 使用内存缓存，启动后立即可用
     - `setup_workspace` 成功后检查是否有新仓库不在 registry 中（增量补充）

2. `updateRegistryEntry(canonicalUrl, updates)` — 增量更新函数
   - 以 canonical URL 为主键定位条目，更新描述、关键词等字段
   - 如果 URL 不在 registry 中，自动追加新条目
   - **触发时机**：
     - `setup_workspace` 成功后（`src/workspace/tool.ts`），如果该仓库在 registry 中没有描述，标记为"待 LLM 补充"
     - 用户澄清仓库归属时，LLM 通过 MCP 工具调用更新（见 Phase 1b）

3. `ensureBareCacheForLocal(localPath)` — 自动缓存函数
   - 当 `DEFAULT_WORK_DIR` 下发现有仓库有 remote 但在 `.repo-cache` 中没有对应的 bare clone 时，自动创建
   - 无 remote 的本地仓库跳过（标记为 `local-only`）
   - 在 `scanAndSyncRegistry()` 中异步调用（fire-and-forget），不阻塞扫描流程。失败时仅 log warning，不影响 registry 生成

4. `getSourceRepoPaths()` — 返回内存中缓存的源仓库根路径 `Set<string>`
   - 由 `scanAndSyncRegistry()` 填充（从 JSON registry 的 localPath 字段解析绝对路径）
   - `isInsideSourceRepo()` 使用此缓存做前缀匹配，避免每次工具调用遍历文件系统
   - 如果缓存未初始化（启动中），fallback 到目录遍历

**文件改动清单：**

| 文件 | 改动 |
|------|------|
| `src/workspace/registry.ts` | 新建，registry 扫描/读取/更新逻辑，canonical URL 规范化 |
| `src/index.ts` | 启动时调用 `scanAndSyncRegistry()` |
| `src/workspace/tool.ts` | `setup_workspace` 成功后触发 registry 增量更新 |

### Phase 1b: Registry 更新 MCP 工具

在 `workspace-manager` MCP server 中新增 `update_repo_registry` 工具，让 LLM 能主动更新 registry：

```typescript
update_repo_registry({
  repo_url: string,        // canonical URL（registry 主键）
  description?: string,    // 仓库描述
  keywords?: string[],     // 追加关键词
})
```

**使用场景**：用户说"帮我看看推荐系统"，LLM 不确定 → 问用户 → 用户说"是 rec-engine" → LLM 调用此工具给 rec-engine 添加关键词"推荐系统"。下次同样说法就能直接匹配。

**文件改动清单：**

| 文件 | 改动 |
|------|------|
| `src/workspace/tool.ts` | 新增 `update_repo_registry` 工具定义 |
| `src/workspace/registry.ts` | 导出 `updateRegistryEntry()` 供 MCP 调用 |

### Phase 2: DEFAULT_WORK_DIR 源仓库保护

在 `canUseTool`（`src/claude/executor.ts`）中增加一层检查：当 cwd 位于 `DEFAULT_WORK_DIR` 下的某个源仓库**工作树内**（包括子目录），且不在 `WORKSPACE_BASE_DIR` 中，拦截代码写操作但放行 git 维护操作。

**判断逻辑：**

`isInsideSourceRepo(path)` 优先使用 registry 扫描后缓存的源仓库路径集合（`getSourceRepoPaths()` 返回的 `Set<string>`），做前缀匹配。仅当缓存未初始化时 fallback 到目录遍历。

```typescript
/**
 * 判断路径是否位于 DEFAULT_WORK_DIR 下某个源仓库的工作树内。
 * 优先使用内存缓存的源仓库路径集合（O(n) 前缀匹配），fallback 到目录遍历。
 */
function isInsideSourceRepo(filePath: string): boolean {
  let resolved: string;
  try {
    // 对于不存在的文件（Write 新建），resolve 其父目录
    resolved = existsSync(filePath)
      ? realpathSync(filePath)
      : realpathSync(dirname(filePath)) + '/' + basename(filePath);
  } catch {
    return false;
  }

  // 排除 WORKSPACE_BASE_DIR（已隔离的工作区）和 .repo-cache
  if (isAutoWorkspacePath(filePath)) return false;

  const cachedPaths = getSourceRepoPaths();
  if (cachedPaths.size > 0) {
    // 快速路径：检查 resolved 是否以某个已知源仓库路径为前缀
    for (const repoRoot of cachedPaths) {
      if (resolved === repoRoot || resolved.startsWith(repoRoot + '/')) {
        return true;
      }
    }
    return false;
  }

  // Fallback：缓存未初始化，向上遍历查找 .git
  const projectsDir = existsSync(config.claude.defaultWorkDir)
    ? realpathSync(config.claude.defaultWorkDir)
    : resolve(config.claude.defaultWorkDir);

  if (!resolved.startsWith(projectsDir + '/') && resolved !== projectsDir) {
    return false;
  }

  let current = resolved;
  while (current.length > projectsDir.length) {
    if (existsSync(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}
```

**关键设计点**：
- 使用 registry 缓存做前缀匹配，不需要每次遍历文件系统
- `realpathSync` 对 `defaultWorkDir` 做安全处理：不存在时用 `resolve()` fallback（首次启动场景）
- 对于 Write 新建文件（路径不存在），resolve 其父目录再拼接文件名
- 排除 WORKSPACE_BASE_DIR 和 .repo-cache

**拦截规则：**

源仓库保护对 **Edit/Write/NotebookEdit 无条件生效**（不管 cwd 在哪，检查 `file_path`）。对 Bash 在 cwd 位于源仓库时生效。

| 工具 | 判断方式 | 行为 |
|------|----------|------|
| `Edit`, `Write`, `NotebookEdit` | **无条件**检查 `inputObj.file_path` 是否 `isInsideSourceRepo()` | 在源仓库内 → **拦截** |
| `Bash` | cwd 在源仓库内时，检查命令内容 | 先拒绝含 shell 元字符（`; \| & \` $ $(`）的命令，再 denylist 匹配写入类命令 → **拦截** |
| `Glob`, `Grep`, `Read`, `LSP` | — | **放行**（只读工具） |
| `mcp__workspace-manager__*` | — | **放行** |

**Bash 命令检查细节**：

当 cwd 在源仓库内时：
1. **先检查 shell 元字符**：如果命令包含 `; | & \` $ $(` 等链式执行元字符，直接拒绝（防止 `git status ; rm -rf` 绕过）。复用现有 `readOnly` 路径中的元字符检查逻辑（executor.ts:621）
2. **再 denylist 匹配**：拦截 `git commit`、`git push`、`git reset`、`git rebase`、`git merge`、`rm`、`mv`、`cp`、`mkdir`、`touch` 等写入类命令。允许 git 维护命令和只读命令通过

这是 denylist 而非 allowlist——个人工具场景下，LLM 不会主动绕过保护，denylist 足以拦截常见误操作（直接 commit/push），同时不限制 agent 在探索阶段运行诊断命令的灵活性。

**`canUseTool` 中的插入位置**：

```
canUseTool 执行顺序：
1. toolDeny 检查（最高优先级）
2. ★ 源仓库保护检查 ★（系统安全机制，不可被 toolAllow 覆盖）
3. toolAllow 检查（管理员显式配置）
4. readOnly 检查（用户权限）
5. 默认 allow
```

**关键**：源仓库保护必须在 `toolAllow` **之前**。因为 `toolAllow` 匹配后会 `return { behavior: 'allow' }` 提前返回（executor.ts:636），如果保护在其之后就永远不会执行。`toolAllow` 是用户权限机制，源仓库保护是系统安全机制，后者优先级更高。

**拦截提示信息**：

```
源仓库保护：目标文件位于 DEFAULT_WORK_DIR 下的源仓库，禁止直接修改。
请使用 setup_workspace 工具从 bare cache 创建隔离工作区后再进行修改。
如果用户明确要求直接在此目录修改，请使用 setup_workspace({ local_path: "<源仓库路径>" }) 创建基于本地路径的隔离工作区。
```

**文件改动清单：**

| 文件 | 改动 |
|------|------|
| `src/claude/executor.ts` | `canUseTool` 中增加源仓库保护检查 |
| `src/workspace/isolation.ts` | 新增 `isInsideSourceRepo()` 导出 |

### Phase 3: System Prompt 优化

#### 3a: 引导 LLM 使用 registry

修改 `buildWorkspaceSystemPrompt()`（`src/claude/executor.ts:149`），在工作区管理指引中添加：

```
当你需要判断用户要在哪个仓库工作时，先读取 `${projectsDir}/.repo-registry.md`，
根据用户消息中的关键词、项目名、技术栈等信息匹配。
如果匹配到唯一仓库，直接调用 setup_workspace（使用 registry 中的 repo URL）。
如果匹配到多个或无法确定，明确询问用户是哪个仓库，不要猜测。
用户澄清后，调用 update_repo_registry 记录新的关键词映射，以便下次自动匹配。
```

同时强化隔离指引：

```
**重要：默认从 bare cache 创建隔离工作区。**
当确定目标仓库后，优先使用 setup_workspace({ repo_url: "..." }) 从 bare cache clone。
仅当用户明确说"直接在 XXX 目录改"时，才使用 setup_workspace({ local_path: "..." })。
不要直接 cd 到源仓库中开始编辑 — 源仓库受写保护，会被拦截。

对于 registry 中标记为 local-only（无 remote）的仓库，使用 setup_workspace({ local_path: "..." })。
```

#### 3b: Restart 后精简 system prompt

增加 `isRestart` 参数控制 `buildWorkspaceSystemPrompt()` 输出。restart 后不再需要仓库探索指引：

- **移除**：全局仓库列表、仓库查找顺序、registry 使用指引、setup_workspace 说明
- **保留**：当前工作区信息、自动开发流程、commit 策略、gh CLI 注意事项、自改自模式（如果适用）

**传递路径**：
1. `ExecuteInput` 新增 `isRestart?: boolean` 字段
2. `event-handler.ts` 在 restart query 中传入 `isRestart: true`（与 `disableWorkspaceTool: true` 同时设置）
3. `executor.ts` 将 `isRestart` 传递给 `buildWorkspaceSystemPrompt(workingDir, { isRestart })`

**注意**：不复用 `disableWorkspaceTool` 来判断 restart，因为 pipeline orchestrator 也会设置 `disableWorkspaceTool: true`（orchestrator.ts:466），但 pipeline 不是 restart 场景，不应精简 prompt。两者是独立的标志位。

**文件改动清单：**

| 文件 | 改动 |
|------|------|
| `src/claude/executor.ts` | 修改 `buildWorkspaceSystemPrompt()` 签名和内容；调用处传入 `isRestart` |

### Phase 4: 测试

| 测试文件 | 覆盖内容 |
|----------|----------|
| `tests/workspace/registry.test.ts` | 新建：`scanAndSyncRegistry` 扫描逻辑（含 canonical URL 合并、local-only 处理、`.` 开头目录排除、atomic write）、`updateRegistryEntry` 增量更新、`ensureBareCacheForLocal` 自动缓存（含无 remote 跳过）、`getSourceRepoPaths` 缓存 |
| `tests/workspace/isolation.test.ts` 或现有 `event-handler.test.ts` | 新增：`isInsideSourceRepo()` 判断逻辑（仓库根目录、子目录 `repo/src/`、WORKSPACE_BASE_DIR 排除、.repo-cache 排除、不存在路径、Write 新建文件路径、defaultWorkDir 不存在时 fallback） |
| `tests/claude/executor.test.ts` 或现有测试 | 新增：canUseTool 源仓库保护（Edit file_path 绝对路径在源仓库内被拒 **不论 cwd 在哪**、Bash `git status` 放行、Bash `git commit` 拦截、Bash 含 `;` 元字符拦截、toolAllow 不能覆盖源仓库保护、setup_workspace 放行）；restart 后 system prompt 精简验证（isRestart=true 去掉仓库列表、pipeline 的 disableWorkspaceTool 不触发精简） |

### Phase 5: 文档更新

| 文件 | 改动 |
|------|------|
| `docs/design/workspace-cache-and-restart.md` | 更新：新增 registry（canonical URL 主键）和源仓库保护机制的描述 |
| `docs/design/design-per-thread-workspace.md` | 更新：补充 registry 在隔离流程中的角色 |
| `CLAUDE.md` | 更新 Architecture → Key Modules 中 workspace 相关描述 |

## 实施顺序

```
Phase 0  → DEFAULT_WORK_DIR 自动推导（config.ts 一行改动）
Phase 1  → registry 系统（基础设施，canonical URL 主键）
Phase 1b → registry MCP 工具（LLM 自更新能力）
Phase 2  → 源仓库保护（安全机制，isInsideSourceRepo 向上遍历）
Phase 3  → system prompt 优化（registry 引导 + restart 精简）
Phase 4  → 测试（每个 Phase 完成后即写对应测试）
Phase 5  → 文档更新（最后统一更新）
```

## 不在本次范围

- **群聊绑定默认仓库**：agents.json 中配置 chatId → repo 映射。有价值但当前 registry + 源仓库保护已覆盖主要场景，可后续迭代。
- **程序侧确定性 matcher**：在 LLM 读 registry 之前，程序先做 URL/绝对路径/精确 alias 的确定性匹配。方向对但增加复杂度，JSON registry 格式已为此预留扩展性，留到后续迭代。
- **消息预扫描提取仓库引用**：在 LLM 执行前用正则从消息中提取 URL/repo 名。收益不确定，LLM 读 registry 后已能较准确匹配。
- **ensureIsolatedWorkspace 上线**：现有函数在 thread-context.ts 中自动隔离。当前方案通过 canUseTool 拦截实现同等效果且更灵活（允许用户 override），暂不启用。
- **收紧 git 命令白名单**：当前允许 git pull/checkout/stash 等，这些确实会修改工作树。但用户意图是"允许维护操作，阻止开发操作"。如果发现实际使用中有问题再收紧。
- **Bash allowlist 模式**：当前源仓库内的 Bash 用 denylist + 元字符拦截。理论上 allowlist 更安全，但个人工具场景下 denylist 足以防止常见误操作，不值得牺牲 agent 灵活性。
- **Registry 投毒防护**：LLM 通过 `update_repo_registry` 写入恶意内容（存储型 prompt injection）。个人工具场景风险极低，后续如需多用户支持再加内容校验。
