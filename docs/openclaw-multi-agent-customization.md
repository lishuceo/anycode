# OpenClaw 多 Agent 用户自定义体系分析

> 分析日期: 2026-02-25
> OpenClaw 版本: 2026.2.17+ (本地源码 `/root/dev/openclaw`)
> 分析目的: 深入理解 OpenClaw 多 Agent 系统的用户自定义能力，为 Anywhere-Code 提供参考

---

## 一、整体架构

OpenClaw 的多 Agent 自定义分为 **8 个维度**，全部通过 `~/.openclaw/openclaw.json` (JSON5 格式) 统一配置：

```
openclaw.json
├── agents.defaults    ← 所有 agent 的默认配置
├── agents.list[]      ← 每个 agent 的个性化覆盖
├── bindings[]         ← 消息路由规则 (消息 → agent)
├── tools              ← 全局工具策略
├── skills             ← 技能系统配置
├── memory             ← 记忆系统配置
├── hooks              ← 事件钩子
└── plugins            ← 插件管理
```

核心设计原则：**defaults + overrides**，agent 级配置完全覆盖（非深度合并）defaults 中的同名字段。

### 目录结构

```
~/.openclaw/
  openclaw.json                          # 主配置文件
  workspace/                             # 默认 agent 工作区
  workspace-<agentId>/                   # per-agent 工作区
  agents/<agentId>/agent/                # per-agent 认证/状态
  agents/<agentId>/sessions/*.jsonl      # per-agent 会话记录
  memory/<agentId>.sqlite                # per-agent 记忆索引
  skills/                                # 全局共享技能目录
```

### 关键源码文件

| 文件 | 用途 |
|------|------|
| `src/config/types.agents.ts` | AgentConfig, AgentsConfig, AgentBinding 类型定义 |
| `src/config/types.agent-defaults.ts` | AgentDefaultsConfig（全量默认配置） |
| `src/config/types.agents-shared.ts` | AgentModelConfig, AgentSandboxConfig |
| `src/config/types.tools.ts` | ToolsConfig, AgentToolsConfig |
| `src/config/zod-schema.agents.ts` | Zod 校验 schema |
| `src/config/zod-schema.agent-runtime.ts` | AgentEntrySchema, AgentToolsSchema |
| `src/config/defaults.ts` | 运行时默认值应用 |
| `src/config/validation.ts` | 配置校验函数 |
| `src/routing/resolve-route.ts` | 消息路由解析 |
| `src/agents/workspace.ts` | Workspace bootstrap 文件加载 |
| `src/agents/system-prompt.ts` | System prompt 构建 |
| `src/agents/pi-tools.policy.ts` | 工具策略管道 |
| `src/agents/subagent-spawn.ts` | 子 agent 生成 |
| `src/agents/skills/workspace.ts` | 技能加载与快照 |
| `src/agents/skills/config.ts` | 技能过滤与资格检查 |
| `src/memory/manager.ts` | 记忆管理器 |
| `extensions/lobster/src/lobster-tool.ts` | Lobster 工作流引擎 |

---

## 二、8 个自定义维度

### 1. Agent 定义与路由

**源码**: `src/config/types.agents.ts`, `src/routing/resolve-route.ts`

#### Agent 配置结构

```typescript
type AgentConfig = {
  id: string;              // 唯一标识（必填）
  default?: boolean;       // 兜底 agent（有且仅有一个）
  name?: string;           // 显示名
  workspace?: string;      // 独立工作区目录
  agentDir?: string;       // 认证/状态目录
  model?: AgentModelConfig;
  skills?: string[];       // 技能白名单（省略=全部，空数组=禁用）
  tools?: AgentToolsConfig;
  subagents?: {
    allowAgents?: string[];  // 可调度的目标 agent（"*" 表示全部）
    model?: AgentModelConfig;
    thinking?: string;
  };
  sandbox?: AgentSandboxConfig;
  identity?: IdentityConfig;
  groupChat?: GroupChatConfig;
  memorySearch?: MemorySearchConfig;
  humanDelay?: HumanDelayConfig;
  heartbeat?: HeartbeatConfig;
};

type AgentsConfig = {
  defaults?: AgentDefaultsConfig;  // 全局默认
  list?: AgentConfig[];            // 各 agent 定义
};
```

#### 路由绑定

消息通过 `bindings[]` 按优先级匹配到 agent：

```json5
bindings: [
  {
    agentId: "support-bot",
    match: {
      channel: "slack",                           // 渠道匹配
      peer: { kind: "channel", id: "C123456" }    // 具体频道/群组
    }
  },
  {
    agentId: "mod-bot",
    match: {
      channel: "discord",
      guildId: "guild-123",
      roles: ["moderator"]                         // Discord 角色匹配
    }
  }
]
```

**匹配优先级**（从高到低）：
1. `peer` — 具体聊天/频道
2. `parentPeer` — 线程父级
3. `guildId + roles` — 服务器 + 角色
4. `guildId` — 服务器
5. `teamId` — 团队
6. `accountId` — 机器人账号
7. `channel` — 渠道
8. `default` agent — 兜底

**Session Key 构成**：`agent:{agentId}:{channel}:{accountId}:{chatType}:{id}` — 天然隔离不同 agent 的会话。

---

### 2. 人格定制 — Workspace Markdown 文件

**源码**: `src/agents/workspace.ts`, `src/agents/system-prompt.ts`, `src/agents/pi-embedded-helpers/bootstrap.ts`

每个 agent 的 workspace 目录包含 **9 个人格文件**，每次 API 调用前重新读取（修改即生效，无需重启）：

| 文件 | 用途 | 子 agent 可见 | 群聊可见 |
|------|------|:------------:|:--------:|
| `SOUL.md` | 核心人格、语气、价值观、伦理边界 | ❌ | ✅ |
| `AGENTS.md` | 工作区规则、记忆指令、平台规范 | ✅ | ✅ |
| `IDENTITY.md` | 身份元数据（名称、emoji、形象、氛围） | ❌ | ✅ |
| `USER.md` | 用户画像与上下文 | ❌ | ✅ |
| `TOOLS.md` | 工具使用指南与本地工具备注 | ✅ | ✅ |
| `HEARTBEAT.md` | 心跳巡检清单 | ❌ | ✅ |
| `BOOTSTRAP.md` | 首次启动引导（完成后删除） | ❌ | ✅ |
| `MEMORY.md` | 长期策展记忆 | ❌ | ❌ |
| `BOOT.md` | 会话初始化指令 | ❌ | ✅ |

#### 加载管线

```
loadWorkspaceBootstrapFiles(workspaceDir)
  ├─ readFileWithCache()         ← 基于 mtime 缓存，避免重复磁盘读取
  ├─ stripFrontMatter()          ← 移除模板 YAML 前置信息
  └─ WorkspaceBootstrapFile[]
       ↓
filterBootstrapFilesForSession(files, sessionKey)
  └─ 子 agent/cron: 仅保留 AGENTS.md + TOOLS.md
       ↓
applyBootstrapHookOverrides(files, config, ...)
  └─ 插件 hook 可动态添加/修改/删除文件
       ↓
buildBootstrapContextFiles(files, { maxChars, totalMaxChars })
  ├─ 单文件上限: 20,000 字符（可配 bootstrapMaxChars）
  ├─ 总上限: 150,000 字符（可配 bootstrapTotalMaxChars）
  ├─ 截断策略: head 70% + 截断标记 + tail 20%
  └─ EmbeddedContextFile[]
       ↓
buildAgentSystemPrompt({ contextFiles, ... })
  ├─ 硬编码段: Tooling / Safety / OpenClaw CLI
  ├─ SOUL.md 特殊处理: 若存在，注入 "embody its persona and tone" 指令
  └─ 所有文件以 "## {path}" 格式注入到 "# Project Context" 段
```

#### SOUL.md 典型结构

```markdown
# Core Truths
- 基础行为原则

# Boundaries
- 伦理护栏与隐私约束

# Vibe
- 沟通风格与语气偏好

# Continuity
- 会话持续性与文件演进规则
```

#### 模板系统

**源码**: `src/agents/workspace-templates.ts`

模板查找顺序：
1. 包根目录 `docs/reference/templates/`
2. 当前工作目录 `docs/reference/templates/`
3. 内置模板 `docs/reference/templates/`

可用变体: `SOUL.md` / `SOUL.dev.md`, `AGENTS.md` / `AGENTS.dev.md` 等。

---

### 3. 模型选择 — 三层覆盖 + 故障转移

**源码**: `src/config/types.agent-defaults.ts`, `src/config/zod-schema.agent-model.ts`

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: ["openai/gpt-5.2"]       // 自动故障转移
      },
      models: {                               // 模型白名单 + 别名
        "anthropic/claude-opus-4-6": {},
        "anthropic/claude-sonnet-4-6": {},
        "fast": { alias: "anthropic/claude-haiku-4-5" }
      }
    },
    list: [
      { id: "fast-agent", model: "anthropic/claude-haiku-4-5" },       // 轻量 agent
      { id: "deep-agent", model: "anthropic/claude-opus-4-6" }         // 重度 agent
    ]
  }
}
```

#### 模型类型

```typescript
type AgentModelConfig =
  | string                                          // 简写: "anthropic/claude-opus-4-6"
  | {
      primary?: string;                             // 主模型
      fallbacks?: string[];                         // 故障转移链
    };
```

#### 关键特性

- `models` 字段既是白名单也是别名表
- 运行时用户可通过 `/model <name>` 切换（受白名单约束）
- **自动故障转移**: provider 限流 / 认证失败 / 超时 → 自动切 fallbacks 中的下一个
- **子 agent 模型继承链**:
  1. `sessions_spawn` 的 `model` 参数（最高）
  2. `agents.list[].subagents.model`
  3. `agents.defaults.subagents.model`
  4. 继承调用者的模型（最低）

---

### 4. 工具访问控制 — 多层策略管道

**源码**: `src/agents/pi-tools.policy.ts`, `src/config/types.tools.ts`

#### 配置结构

```json5
{
  // 全局工具策略
  tools: {
    profile: "full",          // 基线预设: minimal | coding | messaging | full
    allow: ["exec", "read", "write", "edit"],
    deny: ["browser"],
    elevated: {
      enabled: true,
      allowFrom: { whatsapp: ["+1555..."] }  // 仅全局，不可 per-agent
    },
    agentToAgent: {
      enabled: false,
      allow: ["agent1", "agent2"]
    }
  },

  agents: {
    list: [
      {
        id: "restricted-bot",
        tools: {
          profile: "minimal",
          allow: ["read"],
          deny: ["exec", "write", "browser"],     // per-agent 覆盖
          byProvider: {
            "anthropic/claude-haiku-4-5": {        // per-provider 策略
              deny: ["exec"]
            }
          }
        }
      }
    ]
  }
}
```

#### 工具类型

```typescript
type AgentToolsConfig = {
  profile?: "minimal" | "coding" | "messaging" | "full";
  allow?: string[];
  alsoAllow?: string[];     // 追加到 allow 列表（不替换，适合插件工具）
  deny?: string[];
  byProvider?: Record<string, ToolPolicyConfig>;
  elevated?: {
    enabled?: boolean;
    allowFrom?: AgentElevatedAllowFromConfig;
  };
  exec?: ExecToolConfig;
  fs?: FsToolsConfig;
  loopDetection?: ToolLoopDetectionConfig;
  sandbox?: { tools?: { allow?: string[]; deny?: string[] } };
};
```

#### 策略解析规则

1. 全局 `tools` → agent `tools` → provider-specific `byProvider`
2. **deny 优先**: 同时出现在 allow 和 deny 中，deny 生效
3. 支持 **glob 模式匹配**（如 `"sessions_*"`）
4. 工具名称匹配为 case-insensitive

#### 子 agent 工具限制（默认）

| 深度 | 角色 | 默认禁用的工具 | 可获得的额外工具 |
|------|------|---------------|----------------|
| 0 | 主 agent | 无 | 全部 |
| 1 | 子 agent | `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn` | 若 `maxSpawnDepth >= 2`：获得 `sessions_spawn` 等编排工具 |
| 2 | Worker | `sessions_spawn`（永远禁用） | — |

可通过 `tools.subagents.tools.allow/deny` 覆盖子 agent 默认策略。

---

### 5. 子 Agent 生成 — `sessions_spawn`

**源码**: `src/agents/subagent-spawn.ts`, `src/agents/tools/sessions-spawn-tool.ts`

#### 配置

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxSpawnDepth: 2,            // 最大嵌套深度 (1-5, 默认 1)
        maxChildrenPerAgent: 5,      // 单会话最大子 agent 数 (1-20)
        maxConcurrent: 8,            // 全局并发上限
        archiveAfterMinutes: 60,     // 自动归档时间
        model: "anthropic/claude-sonnet-4-6",
        thinking: "medium",          // 子 agent 推理级别
        announceTimeoutMs: 60000     // 结果播报超时
      }
    },
    list: [{
      id: "orchestrator",
      subagents: {
        allowAgents: ["programmer", "reviewer", "tester"],  // 可调度的目标 agent
        model: "anthropic/claude-opus-4-6"
      }
    }]
  }
}
```

#### `sessions_spawn` 工具参数

```typescript
{
  task: string;            // 工作指令（必填）
  label?: string;          // 标识符
  agentId?: string;        // 目标 agent ID
  model?: string;          // 模型覆盖
  thinking?: string;       // 推理级别覆盖
  runTimeoutSeconds?: number; // 默认 900
  thread?: boolean;        // 绑定到渠道线程
  mode?: "run" | "session"; // 一次性 vs 持久化
  cleanup?: "delete" | "keep"; // 归档策略
}
```

#### 生成流程

```
1. 验证阶段
   ├─ 检查深度: callerDepth >= maxSpawnDepth → 拒绝
   ├─ 检查子 agent 数: activeChildren >= maxChildren → 拒绝
   ├─ 验证目标: agentId ∈ subagents.allowAgents → 通过
   └─ 验证 thinking 级别

2. 创建 Session
   ├─ key: agent:{targetAgentId}:subagent:{randomUUID}
   ├─ 设置 spawnDepth: childDepth
   └─ 应用 model / thinking 覆盖

3. 线程绑定（若 thread=true）
   └─ 调用 ensureThreadBindingForSubagentSpawn() hook

4. 任务分发
   ├─ 构建子 prompt（含深度、父 session、任务指令）
   ├─ 调用 gateway agent() 方法，lane: AGENT_LANE_SUBAGENT
   └─ 非阻塞返回: { status: "accepted", runId, childSessionKey }

5. 完成后
   ├─ 自动 announce 结果到请求者（含耗时、token、成本）
   └─ 根据 cleanup 策略归档
```

#### 深度追踪

| 深度 | Session Key 格式 | 角色 | 可生成子 agent？ |
|------|-----------------|------|:---------------:|
| 0 | `agent:{id}:main` | 主 agent | ✅ |
| 1 | `agent:{id}:subagent:{uuid}` | 子 agent/编排者 | 仅当 `maxSpawnDepth >= 2` |
| 2 | `agent:{id}:subagent:{uuid}:subagent:{uuid}` | Worker | ❌ |

#### 级联停止

- `/stop` — 递归停止所有 depth-1 和 depth-2 子 agent
- `/subagents kill <id>` — 停止特定子 agent（含级联）
- `/subagents kill all` — 停止所有子 agent

---

### 6. 记忆隔离

**源码**: `src/memory/session-files.ts`, `src/memory/manager.ts`

#### 隔离矩阵

| 资源 | 隔离级别 |
|------|---------|
| Workspace 文件 (SOUL.md 等) | per-agent workspace 目录 |
| 会话记录 | `~/.openclaw/agents/<agentId>/sessions/*.jsonl` |
| 记忆索引 (SQLite, vector+BM25) | `~/.openclaw/memory/<agentId>.sqlite` |
| 认证 Profiles | per-agent `agentDir`（不可跨 agent 复用） |
| 沙箱容器 | `scope: "agent"` 时 per-agent |

#### 记忆搜索架构

```
Memory System
├── Vector Search (sqlite-vec, embeddings)
├── BM25 Full-text Search
├── Hybrid Ranking (可配权重)
├── MMR Reranking (多样性)
├── Query Expansion (多语言关键词)
├── MEMORY.md 文件监听 + 增量同步
└── Temporal Decay (时间衰减)
```

#### Session 工具可见性

| 级别 | 含义 |
|------|------|
| `self` | 仅当前 session |
| `tree` | 当前 + 所有生成的子 session（默认） |
| `agent` | 当前 agent 的任何 session |
| `all` | 跨 agent（需开启 `tools.agentToAgent.enabled`） |

#### 可控共享

- `memorySearch.extraPaths` — 指向额外记忆源，实现跨 agent 数据访问
- `~/.openclaw/skills/` — 全局共享技能目录
- 要共享凭证：复制 `auth-profiles.json`，**不要** 复用 `agentDir` 路径

---

### 7. 技能系统 — SKILL.md

**源码**: `src/agents/skills/workspace.ts`, `src/agents/skills/config.ts`, `src/shared/config-eval.ts`

#### 加载优先级（高覆盖低）

1. **Workspace** `<workspace>/skills/`
2. **Project agents** `<workspace>/.agents/skills/`
3. **Personal agents** `~/.agents/skills/`
4. **Managed** `~/.openclaw/skills/`
5. **Bundled** 内置技能
6. **Extra dirs** 配置中的额外目录
7. **Plugin skills** 已启用插件的技能

#### SKILL.md Frontmatter 格式

```yaml
---
name: github
description: GitHub CLI integration
user-invocable: true              # 暴露为 /github 斜杠命令
disable-model-invocation: false   # 模型可自动调用
command-dispatch: tool            # 直接分发到工具
command-tool: tool-name
command-arg-mode: raw
metadata:
  openclaw:
    emoji: "🐙"
    always: true                  # 跳过所有 requires 检查
    os: ["linux", "darwin"]
    primaryEnv: "GITHUB_TOKEN"
    requires:
      bins: ["gh"]                # 必须存在的二进制
      anyBins: ["docker", "podman"] # 任一存在即可
      env: ["GITHUB_TOKEN"]       # 必须的环境变量
      config: ["skills.entries.github.apiKey"]
    install:
      - id: brew
        kind: brew                # brew | node | go | uv | download
        formula: gh
        bins: ["gh"]
        label: "Install GitHub CLI (brew)"
---

# Skill Instructions

Use when: [conditions]
NOT for: [exclusions]

## Common Operations
...
```

#### 过滤逻辑 (`shouldIncludeSkill`)

```
1. 配置中 enabled: false → 跳过
2. bundled 白名单检查（若配置了 skills.allowBundled）
3. OS 不匹配 → 跳过
4. always: true → 直接通过（跳过后续检查）
5. requires.bins → 全部检查 PATH（支持远程 sandbox 二进制检查）
6. requires.anyBins → 至少一个存在
7. requires.env → 检查环境变量 + 配置中的 apiKey/env 覆盖
8. requires.config → 检查配置路径是否 truthy
```

#### per-agent 技能过滤

```json5
agents: {
  list: [{
    id: "coding-agent",
    skills: ["github", "shell", "docker"]  // 仅允许这 3 个技能
    // 省略 skills → 允许全部
    // skills: [] → 禁用全部
  }]
}
```

#### 环境变量注入

**源码**: `src/agents/skills/env-overrides.ts`

技能可定义运行时环境变量：
- 通过 `primaryEnv` + 配置中的 `apiKey` 注入 API 密钥
- 通过 `skills.entries.<key>.env` 注入自定义变量
- **作用域限制**: 仅在 agent run 期间生效，完成后自动恢复
- **安全检查**: 阻止 `OPENSSL_CONF` 等危险模式

#### 配置管理

```json5
{
  skills: {
    entries: {
      "github": {
        enabled: true,
        apiKey: "ghp_xxx",          // 映射到 primaryEnv
        env: { GITHUB_ORG: "myorg" },
        config: { customField: "value" }
      }
    },
    load: {
      watch: true,                   // 热重载（chokidar 监听 SKILL.md 变更）
      watchDebounceMs: 250,
      extraDirs: ["path/to/shared/skills"]
    },
    install: {
      nodeManager: "npm"             // npm | pnpm | yarn | bun
    },
    allowBundled: ["skill1"]         // 内置技能白名单
  }
}
```

#### Token 成本

技能注入到 prompt 的开销：
- 基础开销 (1+ 技能): ~195 字符
- 每个技能: ~97 字符 + 转义后的 name/description/location 长度
- 公式: `195 + Sum(97 + len(escaped_fields))`

#### 限制参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxCandidatesPerRoot` | 300 | 每个根目录扫描的最大目录数 |
| `maxSkillsLoadedPerSource` | 200 | 每个来源加载的最大技能数 |
| `maxSkillsInPrompt` | 150 | 注入 prompt 的最大技能数 |
| `maxSkillsPromptChars` | 30,000 | 技能段的字符预算 |
| `maxSkillFileBytes` | 256,000 | 单个 SKILL.md 文件大小上限 |

#### ClawHub 注册表

```bash
clawhub install <skill-slug>    # 安装到 ./skills
clawhub update --all            # 更新所有技能
clawhub sync --all              # 扫描并发布更新
openclaw skills list             # 显示可用技能
openclaw skills info <name>      # 查看详情
openclaw skills enable <name>    # 激活
openclaw skills disable <name>   # 停用
```

---

### 8. Lobster 工作流引擎 — 确定性管道

**源码**: `extensions/lobster/src/lobster-tool.ts`

Lobster 是内置的 **确定性工作流运行时** — LLM 做创造性工作，Lobster 做确定性编排（排序、计数、路由、重试）。

#### 工具接口

```typescript
const lobsterTool = {
  name: "lobster",
  description: "Run Lobster pipelines (typed JSON envelope + resumable approvals)",
  parameters: {
    action: "run" | "resume",      // 动作类型
    pipeline: string,               // 管道 DSL（"run" 时）
    argsJson?: string,              // JSON 参数
    token?: string,                 // 恢复令牌（"resume" 时）
    approve?: boolean,              // 审批决定（"resume" 时）
    cwd?: string,                   // 工作目录
    timeoutMs?: number,             // 超时（默认 20s）
    maxStdoutBytes?: number,        // 最大输出（默认 512KB）
  }
};
```

#### 管道 DSL 格式

```bash
# 链式步骤，JSON stdin/stdout 管道传递
exec --json --shell 'inbox list --json' \
  | exec --stdin json --shell 'inbox categorize --json' \
  | approve --preview-from-stdin --prompt 'Apply changes?'
```

#### YAML 工作流格式 (`.lobster` 文件)

```yaml
name: dev-pipeline
args:
  project: { default: "project-a" }
  task: { default: "implement feature" }

steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout              # 步骤间数据流
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required                  # 人工审批门
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved        # 条件执行
```

#### 步骤配置字段

| 字段 | 用途 |
|------|------|
| `id` | 唯一步骤标识 |
| `command` | CLI 命令 |
| `stdin` | 数据输入: `$step.stdout` 或 `$step.json` |
| `approval` | 标记为需要人工审批 |
| `condition` / `when` | 基于前置步骤结果的条件执行 |
| `lobster` | 嵌套子工作流文件路径 |
| `args` | 子工作流参数 |
| `loop.maxIterations` | 最大循环次数 |
| `loop.condition` | 循环条件（shell 命令，exit 0 继续） |

#### 审批门与恢复令牌

当步骤有 `approval: required` 时，执行暂停并返回：

```json
{
  "status": "needs_approval",
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "resumeToken": "..."
  }
}
```

恢复执行：`{ "action": "resume", "token": "<resumeToken>", "approve": true }`

#### 子工作流 + 循环

```yaml
steps:
  - id: code-review-loop
    lobster: ./code-review.lobster
    args:
      project: ${project}
      task: ${task}
    loop:
      maxIterations: 3
      condition: '! echo "$LOBSTER_LOOP_JSON" | jq -e ".approved" > /dev/null'
```

循环条件接收环境变量：
- `LOBSTER_LOOP_STDOUT` — 子工作流文本输出
- `LOBSTER_LOOP_JSON` — 解析后的 JSON 输出
- `LOBSTER_LOOP_ITERATION` — 当前迭代次数

#### LLM 步骤集成 (`llm-task` 插件)

在确定性管道中插入结构化 LLM 调用：

```yaml
- id: parse
  command: >
    openclaw.invoke --tool llm-task --action json --args-json '{
      "prompt": "Did the review approve?",
      "input": $review.json,
      "schema": {
        "type": "object",
        "properties": {
          "approved": {"type": "boolean"},
          "feedback": {"type": "string"}
        }
      }
    }'
```

#### 典型多 Agent 管道示例

```
orchestrator (Opus)
  ├─ sessions_spawn → programmer (Opus, write+exec)     ← 代码生成
  ├─ sessions_spawn → reviewer (Sonnet, read-only)       ← 代码审查（成本优化）
  └─ sessions_spawn → tester (Sonnet, test runners)      ← 测试

Lobster pipeline:
  code → review ─loop(3)→ review pass? → test → announce via Telegram
```

---

## 三、自定义维度汇总

| 自定义领域 | 机制 | 作用域 |
|-----------|------|--------|
| Agent 人格/行为 | `SOUL.md`, `AGENTS.md`, `USER.md` | per-agent workspace |
| 模型选择 | `agents.list[].model`, `agents.defaults.model` | per-agent |
| 模型白名单 | `agents.list[].models`, `agents.defaults.models` | per-agent |
| 工具访问 | `agents.list[].tools.allow/deny` | per-agent |
| 提权工具 | `tools.elevated` | 仅全局 |
| Agent 间通信 | `tools.agentToAgent.enabled/allow` | 全局 |
| 记忆/会话 | 按 agent ID 自动隔离 | per-agent |
| 记忆搜索路径 | `memorySearch.extraPaths` | per-agent |
| 沙箱 | `agents.list[].sandbox.mode/scope` | per-agent |
| 子 agent 生成 | `agents.list[].subagents.*` | per-agent |
| 子 agent 目标 | `subagents.allowAgents` | per-agent |
| 技能 | workspace `skills/` 目录 + `skills.entries` | per-agent workspace + 全局 |
| 技能白名单 | `agents.list[].skills` | per-agent |
| 消息路由 | `bindings[]` + match 规则 | 全局 |
| 工作流管道 | `.lobster` YAML 文件 + Lobster 运行时 | per-workspace |
| 心跳巡检 | `agents.list[].heartbeat` | per-agent |
| 并发控制 | `agents.defaults.maxConcurrent` | 全局 |

---

## 四、对 Anywhere-Code 的启示

详见 [openclaw-analysis.md](./openclaw-analysis.md) 的借鉴分析。结合本次深入分析，补充以下要点：

| 维度 | OpenClaw 复杂度 | Anywhere-Code 建议 |
|------|-----------------|-------------------|
| Agent 定义 | 完整 config schema + Zod 验证 | 飞书场景下可简化为 per-chat agent profile |
| 人格文件 | 9 个 Markdown 文件 | 支持 CLAUDE.md + 自定义 system prompt append 即可 |
| 模型选择 | 三层覆盖 + 故障转移 | Claude-only，无需多模型切换 |
| 工具策略 | 多层管道 + glob 匹配 | 当前 `canUseTool` 全放行 → 建议加分类策略 |
| 子 Agent | 深度/并发/白名单控制 | 可借鉴用于 pipeline reviewer 的并行调度 |
| 记忆隔离 | per-agent sqlite + vector + BM25 | 当前依赖 SDK resume，可先做会话摘要持久化 |
| 技能系统 | SKILL.md + 热重载 + ClawHub 注册表 | Claude Agent SDK 已有 Skill 支持，按需扩展 |
| 工作流引擎 | Lobster DSL + 审批门 + 循环 | 当前 pipeline orchestrator 已覆盖核心场景 |

**最核心的借鉴点**：OpenClaw 的 "defaults + per-agent overrides" 模式是多 agent 自定义的基石。如果 Anywhere-Code 后续需要支持不同飞书群使用不同配置（模型、工具权限、system prompt），这个模式可以直接复用。
