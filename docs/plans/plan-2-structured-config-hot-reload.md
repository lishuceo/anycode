---
summary: "将 .env 平铺配置替换为结构化 JSON5 + Zod 校验 + 热重载"
status: draft
owner: lishuceo
last_updated: "2026-02-23"
read_when:
  - 修改配置系统或 src/config.ts
  - 新增配置项
  - 需要配置热重载能力
---

# Plan 2: 结构化配置系统 + 热重载

## 目标

将当前平铺的 `.env` 环境变量配置替换为结构化的 JSON5 配置文件，支持 Zod schema 校验、类型安全、热重载（配置变更无需重启服务），同时保持对现有 `.env` 的向后兼容。

## 现状分析

当前 `src/config.ts` 的问题：
- **平铺环境变量**: 40+ 个 `process.env.XXX`，无层级结构，新增配置项容易命名冲突
- **弱类型**: `parseInt(process.env.XXX || '300', 10)` 式的手动解析，无运行时校验
- **无热重载**: 修改配置需要重启进程，pipeline 运行中断
- **无注释**: `.env` 文件不支持行内注释，复杂配置难以自文档化
- **无默认值文件**: 默认值散布在 `config.ts` 各处，难以总览

## 架构设计

### 配置加载优先级 (高 → 低)

```
1. 环境变量 (process.env)       ← 部署时覆盖
2. anywhere-code.json5           ← 主配置文件
3. .env 文件 (dotenv)           ← 向后兼容
4. 代码内默认值 (Zod .default()) ← 兜底
```

### 配置文件结构

```json5
// anywhere-code.json5
{
  // 飞书渠道配置
  feishu: {
    appId: "cli_xxx",
    appSecret: "xxx",
    eventMode: "websocket",     // "websocket" | "webhook"
    encryptKey: "",             // webhook 模式的签名密钥
    verifyToken: "",            // webhook 模式的验证 token
  },

  // 安全配置
  security: {
    allowedUserIds: [],          // 为空允许所有用户
    ownerUserId: "",             // 管理员 open_id
  },

  // Claude Code 配置
  claude: {
    defaultWorkDir: "/home/ubuntu/projects",
    timeoutSeconds: 300,         // 单步空闲超时
    model: "claude-opus-4-6",
    thinking: "adaptive",        // "adaptive" | "disabled"
    effort: "max",               // "low" | "medium" | "high" | "max"
    maxTurns: 500,
    maxBudgetUsd: 50,
  },

  // 工作区配置
  workspace: {
    baseDir: "/home/ubuntu/projects/anywhere-code-work-dir",
    branchPrefix: "feat/claude-session",
  },

  // 仓库缓存配置
  repoCache: {
    dir: "/repos/cache",
    maxAgeDays: 30,
    maxSizeGb: 50,
    fetchIntervalMin: 10,
  },

  // 数据库配置
  db: {
    sessionDbPath: "./data/sessions.db",
    pipelineDbPath: "./data/pipelines.db",
  },

  // 服务器配置
  server: {
    port: 3000,
    logLevel: "info",            // "debug" | "info" | "warn" | "error"
  },
}
```

### Zod Schema

```typescript
// src/config/schema.ts
import { z } from 'zod';

export const configSchema = z.object({
  feishu: z.object({
    appId: z.string().min(1, 'FEISHU_APP_ID is required'),
    appSecret: z.string().min(1, 'FEISHU_APP_SECRET is required'),
    eventMode: z.enum(['websocket', 'webhook']).default('websocket'),
    encryptKey: z.string().default(''),
    verifyToken: z.string().default(''),
  }),

  security: z.object({
    allowedUserIds: z.array(z.string()).default([]),
    ownerUserId: z.string().default(''),
  }),

  claude: z.object({
    defaultWorkDir: z.string().default('/home/ubuntu/projects'),
    timeoutSeconds: z.number().int().positive().default(300),
    model: z.string().default('claude-opus-4-6'),
    thinking: z.enum(['adaptive', 'disabled']).default('adaptive'),
    effort: z.enum(['low', 'medium', 'high', 'max']).default('max'),
    maxTurns: z.number().int().positive().default(500),
    maxBudgetUsd: z.number().positive().default(50),
  }),

  workspace: z.object({
    baseDir: z.string().optional(), // 默认值依赖 claude.defaultWorkDir，运行时计算
    branchPrefix: z.string().default('feat/claude-session'),
  }),

  repoCache: z.object({
    dir: z.string().default('/repos/cache'),
    maxAgeDays: z.number().int().positive().default(30),
    maxSizeGb: z.number().int().positive().default(50),
    fetchIntervalMin: z.number().int().positive().default(10),
  }),

  db: z.object({
    sessionDbPath: z.string().default('./data/sessions.db'),
    pipelineDbPath: z.string().default('./data/pipelines.db'),
  }),

  server: z.object({
    port: z.number().int().min(1).max(65535).default(3000),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;
```

## 实施步骤

### Phase 1: 配置加载器

1. **创建 `src/config/schema.ts`**
   - Zod schema 定义 (如上)
   - 导出 `AppConfig` 类型

2. **创建 `src/config/loader.ts`**
   - `loadConfigFile(path)`: 读取 JSON5 文件，`json5` 库解析
   - `loadEnvCompat()`: 从 `process.env` / `.env` 构建与 schema 同结构的对象 (向后兼容层)
   - `mergeConfigs(file, env, defaults)`: 深度合并，优先级: env > file > defaults
   - `validateConfig(raw)`: Zod parse，返回 `AppConfig` 或 throw 带详细错误信息

3. **创建 `src/config/index.ts`**
   - 导出 `config` 单例 (Proxy 包装，支持热重载)
   - `initConfig()`: 启动时调用，加载 + 校验
   - `reloadConfig()`: 热重载时调用

### Phase 2: 热重载机制

4. **创建 `src/config/watcher.ts`**
   - 使用 `node:fs.watch` 监听配置文件变更
   - Debounce 500ms (避免编辑器保存时的多次触发)
   - 变更后:
     1. 读取新配置文件
     2. Zod 校验 (失败则 log 警告，保持旧配置)
     3. Diff 检测实际变更的字段
     4. 通过 EventEmitter 发出 `config:changed` 事件，携带变更详情

5. **实现热重载响应**
   - `server.ts`: `server.port` 变更 → log 警告（端口变更需重启）
   - `claude/executor.ts`: `claude.*` 变更 → 新 query 使用新配置（运行中的不受影响）
   - `utils/logger.ts`: `server.logLevel` 变更 → 动态调整 Pino level
   - `utils/security.ts`: `security.*` 变更 → 立即生效

6. **哪些配置支持热重载，哪些不支持**

   | 配置节 | 热重载 | 说明 |
   |--------|--------|------|
   | `feishu.*` | 否 | SDK client 需要重建，涉及 WebSocket 连接 |
   | `security.*` | 是 | 下次消息检查时生效 |
   | `claude.*` | 是 | 下次 query 使用新值 |
   | `workspace.*` | 是 | 下次 workspace 创建使用新值 |
   | `repoCache.*` | 是 | 下次 cache 操作使用新值 |
   | `db.*` | 否 | 数据库路径变更需重启 |
   | `server.port` | 否 | 端口变更需重启 |
   | `server.logLevel` | 是 | 立即生效 |

### Phase 3: 迁移现有代码

7. **替换 `src/config.ts`**
   - 删除旧的 `config.ts`
   - 新的 `src/config/index.ts` 导出完全相同的 `config` 对象结构
   - 所有 `import { config } from './config.js'` 改为 `import { config } from './config/index.js'`

8. **更新 `src/index.ts`**
   - 调用 `initConfig()` 替代直接使用 `config`
   - 调用 `startConfigWatcher()` 启动文件监听

9. **创建默认配置文件**
   - `anywhere-code.example.json5`: 带注释的示例配置
   - 更新 README 说明新配置方式

### Phase 4: 环境变量兼容层

10. **实现 env → config 映射**

    ```typescript
    // src/config/env-compat.ts
    const ENV_MAP: Record<string, string> = {
      'FEISHU_APP_ID':            'feishu.appId',
      'FEISHU_APP_SECRET':        'feishu.appSecret',
      'FEISHU_EVENT_MODE':        'feishu.eventMode',
      'FEISHU_ENCRYPT_KEY':       'feishu.encryptKey',
      'FEISHU_VERIFY_TOKEN':      'feishu.verifyToken',
      'ALLOWED_USER_IDS':         'security.allowedUserIds',  // 特殊: 逗号分隔 → 数组
      'OWNER_USER_ID':            'security.ownerUserId',
      'DEFAULT_WORK_DIR':         'claude.defaultWorkDir',
      'CLAUDE_TIMEOUT':           'claude.timeoutSeconds',    // 特殊: string → number
      'CLAUDE_MODEL':             'claude.model',
      'CLAUDE_THINKING':          'claude.thinking',
      'CLAUDE_EFFORT':            'claude.effort',
      'CLAUDE_MAX_TURNS':         'claude.maxTurns',
      'CLAUDE_MAX_BUDGET_USD':    'claude.maxBudgetUsd',
      'WORKSPACE_BASE_DIR':       'workspace.baseDir',
      'WORKSPACE_BRANCH_PREFIX':  'workspace.branchPrefix',
      'REPO_CACHE_DIR':           'repoCache.dir',
      'REPO_CACHE_MAX_AGE_DAYS':  'repoCache.maxAgeDays',
      'REPO_CACHE_MAX_SIZE_GB':   'repoCache.maxSizeGb',
      'REPO_CACHE_FETCH_INTERVAL_MIN': 'repoCache.fetchIntervalMin',
      'SESSION_DB_PATH':          'db.sessionDbPath',
      'PIPELINE_DB_PATH':         'db.pipelineDbPath',
      'PORT':                     'server.port',
      'LOG_LEVEL':                'server.logLevel',
    };
    ```

    规则：
    - 环境变量优先于配置文件中的同名字段
    - `ALLOWED_USER_IDS` 逗号分隔自动转数组
    - 数字类型自动 parseInt/parseFloat

## 文件变更清单

### 新增文件
```
src/config/
├── index.ts              # 配置入口，导出 config 单例
├── schema.ts             # Zod schema 定义
├── loader.ts             # 配置文件加载 + 合并逻辑
├── watcher.ts            # 文件变更监听 + 热重载
├── env-compat.ts         # 环境变量 → config 映射
└── __tests__/
    ├── schema.test.ts    # Schema 校验测试
    ├── loader.test.ts    # 加载器测试 (JSON5 解析、合并)
    └── env-compat.test.ts # 环境变量兼容性测试
anywhere-code.example.json5   # 示例配置文件
```

### 修改文件
```
src/config.ts             → 删除 (被 src/config/index.ts 替代)
src/index.ts              → 使用 initConfig() + startConfigWatcher()
src/utils/logger.ts       → 支持动态 level 变更
package.json              → 新增 json5 依赖
```

### 不变文件
```
所有 import { config } from './config.js' 的文件
  → 路径改为 import { config } from './config/index.js'
  → config 对象结构完全不变，只是来源从 env 变为 JSON5 + env
```

## 依赖

- `json5` (npm): JSON5 解析器 (~8KB, 无子依赖)
- `zod` (已有): Schema 校验

## 关键约束

1. **100% 向后兼容**: 不创建 `anywhere-code.json5` 时，纯靠 `.env` 继续工作
2. **配置对象结构不变**: `config.feishu.appId` 等路径保持一致，消费方零改动
3. **热重载安全**: 校验失败保持旧配置，不会因为配置文件语法错误导致服务崩溃
4. **原子性**: 热重载是整体替换，不会出现半新半旧的混合状态

## 预期收益

- JSON5 支持注释，配置文件自文档化
- Zod 校验在启动时发现配置错误（而非运行时 NaN/undefined）
- 热重载 `security.allowedUserIds` / `claude.model` 等无需重启
- 为 Plan 1（多渠道配置）打基础: `channels: { feishu: {...}, telegram: {...} }`
