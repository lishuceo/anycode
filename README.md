# Feishu Claude Code Bridge

通过飞书（Lark）对话控制 Linux 服务器上的 Claude Code，实现飞书驱动的 AI 编程。

## 架构概览

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│   飞书用户    │◄───►│   飞书开放平台    │◄───►│  Bridge Server      │
│  (手机/桌面)  │     │  (Event/Callback) │     │  (本项目)            │
└──────────────┘     └──────────────────┘     └─────────┬───────────┘
                                                        │
                                                        ▼
                                              ┌─────────────────────┐
                                              │  Claude Code CLI    │
                                              │  (子进程 / SDK)      │
                                              │  ──────────────     │
                                              │  ✦ 读写文件          │
                                              │  ✦ 执行命令          │
                                              │  ✦ Git 操作          │
                                              │  ✦ 代码分析          │
                                              └─────────────────────┘
```

## 核心设计

### 1. 系统组件

| 组件 | 职责 | 技术选型 |
|------|------|---------|
| **HTTP Server** | 接收飞书 Webhook 事件 | Express + TypeScript |
| **Feishu Client** | 飞书 API 交互（收发消息、卡片） | @larksuiteoapi/node-sdk |
| **Claude Executor** | 调用 Claude Agent SDK 执行任务 | @anthropic-ai/claude-agent-sdk |
| **Session Manager** | 管理用户会话、上下文隔离 | 内存 + 可选持久化 |
| **Message Formatter** | 飞书富文本 ↔ Claude 文本转换 | 自定义 |
| **Queue Manager** | 任务排队，防止并发冲突 | 内存队列 |

### 2. 消息流转

```
用户在飞书发送消息
        │
        ▼
飞书平台推送 Event (HTTP POST)
        │
        ▼
Event Handler 接收并验证
        │
        ├─ 提取消息内容 (文本/文件/图片)
        ├─ 识别用户 & 会话
        │
        ▼
Session Manager 查找/创建会话
        │
        ├─ 每个飞书会话(chat_id) 对应一个工作目录
        ├─ 维护对话历史上下文
        │
        ▼
Queue Manager 排队执行
        │
        ▼
Claude Executor 调用 Agent SDK
        │
        ├─ 调用 query() 启动 Claude Agent
        ├─ SDK 自动管理工具执行、权限、流式输出
        ├─ 通过 session_id 实现会话续接 (--resume)
        │
        ▼
捕获 Claude Code 输出 (流式)
        │
        ├─ 实时状态更新 → 飞书消息卡片更新
        ├─ 最终结果 → 飞书富文本消息
        │
        ▼
Message Formatter 格式化输出
        │
        ├─ 代码块 → 飞书代码块
        ├─ 长文本 → 分段发送 / 文件附件
        ├─ Markdown → 飞书富文本
        │
        ▼
Feishu Client 发送回复
```

### 3. 会话管理策略

```typescript
// 每个飞书对话对应一个 Session
interface Session {
  chatId: string;          // 飞书会话 ID
  userId: string;          // 飞书用户 ID
  workingDir: string;      // 工作目录 (可配置)
  conversationId?: string; // Claude Code 会话 ID (用于上下文续接)
  createdAt: Date;
  lastActiveAt: Date;
  status: 'idle' | 'busy' | 'error';
}

// 会话隔离策略:
// - 群聊: 一个群 = 一个会话, 共享工作目录
// - 私聊: 一个用户 = 一个会话
// - 可通过命令切换工作目录: /cd /path/to/project
```

### 4. Claude Agent SDK 集成

本项目使用 **[@anthropic-ai/claude-agent-sdk](https://platform.claude.com/docs/en/agent-sdk/overview)** — 官方 Agent SDK，将 Claude Code 的全部能力作为库使用。

> Claude Code SDK 已更名为 Claude Agent SDK。

**核心 API: `query()`**

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const q = query({
  prompt: "帮我修复 auth.py 中的 bug",
  options: {
    cwd: "/home/user/my-project",
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: '你正在通过飞书消息与用户交互。请保持回复简洁。',
    },
    settingSources: ['project'],  // 加载 CLAUDE.md
    maxTurns: 50,
    maxBudgetUsd: 5,
    resume: previousSessionId,    // 会话续接
  },
});

// query() 返回 AsyncGenerator<SDKMessage>
for await (const message of q) {
  switch (message.type) {
    case 'system':     // 初始化信息 (model, tools, session_id)
    case 'assistant':  // Claude 的回复文本
    case 'result':     // 最终结果 (成功/失败, 耗时, 花费)
    case 'tool_progress': // 工具执行进度
    // ...
  }
}
```

**SDK 的优势 (对比直接调用 CLI)：**

| 特性 | CLI 子进程 | Agent SDK (本项目) |
|------|-----------|-------------------|
| 集成方式 | spawn + stdin/stdout | `import { query }` 直接调用 |
| 类型安全 | 需要手动解析 JSON | 完整 TypeScript 类型 |
| 工具执行 | 需要自己解析 stream-json | SDK 自动管理 |
| 权限控制 | CLI 参数 | `permissionMode` / `canUseTool` 回调 |
| 会话续接 | `--resume` 手动传参 | `resume` option |
| 中断操作 | `process.kill()` | `query.close()` / `AbortController` |
| 花费追踪 | 需要自己解析 | `result.total_cost_usd` |
| Hooks | 不支持 | `PreToolUse` / `PostToolUse` 等 |
| MCP | 命令行配置 | `mcpServers` 编程配置 |
| 子 Agent | 不支持 | `agents` 定义 |

### 5. 飞书消息交互设计

#### 用户指令格式

| 指令 | 说明 | 示例 |
|------|------|------|
| 直接文本 | 发送给 Claude Code | `帮我看看 src/index.ts 有什么问题` |
| `/project <path>` | 切换工作目录 | `/project /home/user/my-app` |
| `/status` | 查看当前会话状态 | `/status` |
| `/stop` | 中断当前执行 | `/stop` |
| `/reset` | 重置会话 | `/reset` |
| `/history` | 查看对话历史 | `/history` |

#### 回复消息格式

使用飞书 **消息卡片 (Interactive Card)** 实现丰富展示：

```
┌────────────────────────────────────┐
│ 🤖 Claude Code                    │
│ ────────────────────               │
│ ✅ 任务完成                         │
│                                    │
│ 已修改文件:                         │
│ • src/index.ts (+15, -3)           │
│ • src/utils.ts (+8, -0)            │
│                                    │
│ ┌──────────────────────────┐       │
│ │ // src/index.ts          │       │
│ │ export function main() { │       │
│ │   console.log("hello");  │       │
│ │ }                        │       │
│ └──────────────────────────┘       │
│                                    │
│ [查看完整输出]  [继续对话]  [撤销]   │
└────────────────────────────────────┘
```

执行中状态卡片（实时更新）：

```
┌────────────────────────────────────┐
│ 🤖 Claude Code                    │
│ ────────────────────               │
│ ⏳ 执行中...                        │
│                                    │
│ 正在读取 src/index.ts...           │
│ 正在分析代码结构...                  │
│ 正在修改文件...                     │
│                                    │
│ ⏱️ 已运行 12s                      │
│                                    │
│ [中断执行]                          │
└────────────────────────────────────┘
```

### 6. 安全设计

```yaml
安全措施:
  认证:
    - 飞书 Event 签名验证 (Verification Token / Encrypt Key)
    - 用户白名单 (只允许特定用户/群使用)
    
  授权:
    - 工作目录白名单 (限制可操作的目录范围)
    - 危险命令拦截 (rm -rf /, sudo 等)
    - Claude Code 工具权限控制 (allowedTools)
    
  隔离:
    - 每个会话独立工作目录
    - 非 root 用户运行
    
  审计:
    - 所有操作日志记录
    - 飞书消息存档
```

### 7. 部署方案

```yaml
部署方式: 单机部署 (Linux 服务器)

前置条件:
  - Node.js >= 18
  - Claude Code CLI 已安装并认证
  - 飞书开放平台应用已创建

运行方式:
  开发: npm run dev (ts-node + nodemon)
  生产: npm run build && npm start (PM2 管理)

网络要求:
  - 服务器需有公网 IP 或使用内网穿透 (ngrok/frp)
  - 飞书 Webhook 回调需要 HTTPS (可用 nginx 反代 + Let's Encrypt)

环境变量:
  FEISHU_APP_ID:        飞书应用 App ID
  FEISHU_APP_SECRET:    飞书应用 App Secret
  FEISHU_ENCRYPT_KEY:   飞书事件加密 Key (可选)
  FEISHU_VERIFY_TOKEN:  飞书验证 Token
  ALLOWED_USER_IDS:     允许使用的飞书用户 ID 列表
  DEFAULT_WORK_DIR:     默认工作目录
  PORT:                 服务监听端口 (默认 3000)
  ANTHROPIC_API_KEY:    Anthropic API Key (Claude Code 需要)
```

## 项目结构

```
/workspace
├── src/
│   ├── index.ts                 # 入口文件
│   ├── server.ts                # Express HTTP 服务器
│   ├── config.ts                # 配置管理
│   ├── feishu/
│   │   ├── client.ts            # 飞书 API 客户端 (@larksuiteoapi/node-sdk)
│   │   ├── event-handler.ts     # EventDispatcher + 消息处理逻辑
│   │   └── message-builder.ts   # 消息卡片构建器
│   ├── claude/
│   │   ├── executor.ts          # Claude Agent SDK 执行器
│   │   └── types.ts             # Claude SDK 类型重导出 + 自定义类型
│   ├── session/
│   │   ├── manager.ts           # 会话管理器
│   │   ├── queue.ts             # 任务队列
│   │   └── types.ts             # 会话相关类型定义
│   └── utils/
│       ├── logger.ts            # 日志工具
│       └── security.ts          # 安全检查工具
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── README.md
```

## 快速开始

### 1. 创建飞书应用

1. 访问 [飞书开放平台](https://open.feishu.cn/app)
2. 创建企业自建应用
3. 开通权限：
   - `im:message` - 获取与发送单聊、群组消息
   - `im:message:send_as_bot` - 以应用身份发送消息
   - `im:chat` - 获取群组信息
4. 配置事件订阅：
   - 请求地址: `https://your-server.com/feishu/webhook`
   - 订阅事件: `im.message.receive_v1` (接收消息)
5. 记录 App ID、App Secret、Encrypt Key、Verification Token

### 2. 设置 Anthropic API Key

```bash
# 从 https://console.anthropic.com/ 获取 API Key
export ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
```

### 3. 部署本项目

```bash
git clone <repo-url>
cd feishu-claude-bridge
cp .env.example .env
# 编辑 .env 填入配置
npm install
npm run dev   # 开发模式
npm start     # 生产模式
```

### 4. 配置网络

```bash
# 方式1: nginx 反代 (推荐生产环境)
# 方式2: ngrok 内网穿透 (开发测试)
ngrok http 3000
```

## 技术栈

- **Runtime**: Node.js 18+ / TypeScript 5
- **HTTP**: Express
- **飞书 SDK**: @larksuiteoapi/node-sdk
- **Claude Agent SDK**: @anthropic-ai/claude-agent-sdk (官方 SDK)
- **日志**: pino
- **进程管理**: PM2 (生产环境)

## License

MIT
