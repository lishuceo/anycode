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
  - 飞书开放平台应用已创建 (开启机器人能力 + 长连接事件订阅)
  - Anthropic API Key

运行方式:
  开发: npm run dev (tsx watch)
  生产: npm run build && npm start (PM2 管理)

网络要求:
  - WebSocket 模式 (默认): 无需公网 IP，SDK 主动连接飞书
  - Webhook 模式 (可选): 需要公网 HTTPS 地址

环境变量 (必填):
  FEISHU_APP_ID:        飞书应用 App ID
  FEISHU_APP_SECRET:    飞书应用 App Secret
  ANTHROPIC_API_KEY:    Anthropic API Key

环境变量 (可选):
  FEISHU_EVENT_MODE:    事件接收模式 (websocket | webhook，默认 websocket)
  ALLOWED_USER_IDS:     允许使用的飞书用户 ID 列表
  DEFAULT_WORK_DIR:     默认工作目录
  PORT:                 服务监听端口 (默认 3000)
  FEISHU_ENCRYPT_KEY:   仅 webhook 模式需要
  FEISHU_VERIFY_TOKEN:  仅 webhook 模式需要
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

### 第一步：创建飞书应用

#### 1.1 进入飞书开放平台

打开 [飞书开放平台](https://open.feishu.cn/app)，登录你的飞书账号。

#### 1.2 创建应用

1. 点击 **「创建企业自建应用」**
2. 填写应用名称（如 `Claude Code Bot`）和描述
3. 选择应用图标，点击 **「创建」**

#### 1.3 记录凭证信息

进入应用后，在 **「凭证与基础信息」** 页面记录以下信息：

| 字段 | 位置 | 对应 .env 变量 |
|------|------|---------------|
| App ID | 凭证与基础信息 → App ID | `FEISHU_APP_ID` |
| App Secret | 凭证与基础信息 → App Secret（点击显示） | `FEISHU_APP_SECRET` |

#### 1.4 开启机器人能力

1. 左侧菜单 → **「添加应用能力」**
2. 找到 **「机器人」**，点击 **「添加」**
3. 这一步让你的应用可以作为机器人与用户对话

#### 1.5 配置权限

左侧菜单 → **「权限管理」**，搜索并开通以下权限：

**发送类**（机器人发消息、回复、更新卡片）：

| 权限名称 | 权限标识 | 用途 |
|---------|---------|------|
| 以应用的身份发消息 | `im:message:send_as_bot` | 发送消息、回复消息 |
| 更新应用发送的消息 | `im:message:update` | 更新进度卡片（从"执行中"变为"执行完成"） |

**接收类**（接收用户消息事件，至少开一个）：

| 权限名称 | 权限标识 | 适用场景 |
|---------|---------|---------|
| 获取用户发给机器人的单聊消息 | `im:message.p2p_msg:readonly` | 私聊场景（必开） |
| 获取用户在群组中@机器人的消息 | `im:message.group_at_msg:readonly` | 群聊场景（推荐） |
| 获取群组中所有消息 | `im:message.group_msg:readonly` | 群聊不@也能响应（可选） |

> 开通后需要由管理员审批，如果你本身是管理员则自动通过。

#### 1.6 配置事件订阅

让飞书把用户消息推送给你。本项目使用飞书官方 SDK 的 **WebSocket 长连接模式**，无需注册公网域名、无需配置加密策略。

1. 左侧菜单 → **「事件与回调」**
2. 选择 **「使用长连接接收事件」**

   > 这一步很重要。飞书提供两种事件推送方式，选「长连接」就对了。
   > 飞书官方说明：*无需注册公网域名或配置加密策略，仅需使用官方 SDK 启动长连接客户端即可。*

3. 点击 **「添加事件」**，搜索并添加：

   | 事件名称 | 事件标识 |
   |---------|---------|
   | 接收消息 | `im.message.receive_v1` |

4. 完成。不需要填写回调 URL，不需要 Encrypt Key，不需要 Verification Token

> **为什么不用 HTTP Webhook？**
> 传统的 webhook 模式需要你有一个公网可访问的 HTTPS 地址，还有 challenge 验证、加密解密等配置。
> 长连接模式完全省掉了这些——SDK 主动连接飞书服务器，在内网、没有域名的机器上也能直接用。
> 如果你确实需要 webhook 模式（比如生产环境有固定域名），在 `.env` 中设置 `FEISHU_EVENT_MODE=webhook` 即可切换，详见 [附录：HTTP Webhook 模式](#附录http-webhook-模式)。

#### 1.7 发布应用

1. 左侧菜单 → **「版本管理与发布」**
2. 点击 **「创建版本」**，填写版本号和更新说明
3. 提交审核（企业管理员审批通过后生效）

> 开发测试阶段，可以在 **「应用发布范围」** 中先只选择自己，不需要等审批。

#### 1.8 验证：在飞书中找到机器人

应用发布后：
- **私聊**：在飞书搜索框搜索你的应用名称，点击发起对话
- **群聊**：在群设置中添加机器人，选择你的应用

---

### 第二步：准备服务器环境

#### 2.1 安装 Node.js

```bash
# 使用 nvm 安装 Node.js 18+
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.bashrc
nvm install 22
node -v  # 确认 v22.x
```

#### 2.2 获取 Anthropic API Key

1. 访问 [Anthropic Console](https://console.anthropic.com/)
2. 注册/登录账号
3. 进入 **API Keys** 页面，创建一个新的 API Key
4. 复制保存 Key（格式为 `sk-ant-api03-...`）

---

### 第三步：部署本项目

#### 3.1 克隆项目

```bash
git clone https://github.com/lishuceo/anywhere-code.git
cd anywhere-code
```

#### 3.2 安装依赖

```bash
npm install
```

#### 3.3 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入你在第一步记录的信息：

```bash
# === 飞书应用配置 (只需要 App ID 和 App Secret) ===
FEISHU_APP_ID=cli_xxxxxxxxxx          # 第1.3步的 App ID
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx     # 第1.3步的 App Secret
FEISHU_EVENT_MODE=websocket            # 长连接模式，无需公网

# === Claude 配置 ===
ANTHROPIC_API_KEY=sk-ant-api03-xxxxx   # 第2.2步的 API Key
DEFAULT_WORK_DIR=/home/ubuntu/projects # 默认工作目录

# === 安全配置 ===
ALLOWED_USER_IDS=                      # 留空=所有人可用, 或填 open_id 逗号分隔
```

#### 3.4 启动服务

```bash
# 开发模式 (自动重载)
npm run dev

# 生产模式
npm run build
npm start
```

启动成功会看到：
```
Feishu WebSocket connected
  无需配置回调地址，无需公网 IP
```

> 使用 WebSocket 长连接模式，**不需要配置公网地址、不需要 ngrok、不需要 nginx**。
> 启动后 SDK 自动连接飞书，就可以在飞书里和机器人对话了。

---

### 第四步（可选）：生产环境部署

> WebSocket 模式在开发和生产环境都可以用。以下仅在你需要进程守护时参考。

#### 使用 PM2 守护进程

```bash
# 安装 PM2
npm install -g pm2

# 构建并启动
npm run build
pm2 start npm --name "feishu-claude" -- start

# 持久化：保存进程列表 + 开机自启
pm2 save
pm2 startup    # 按提示执行输出的命令
```

#### PM2 常用命令

```bash
pm2 status                    # 查看所有进程状态
pm2 logs feishu-claude        # 查看实时日志 (Ctrl+C 退出)
pm2 logs feishu-claude --lines 50  # 查看最近 50 行日志
pm2 restart feishu-claude     # 重启服务
pm2 stop feishu-claude        # 停止服务
pm2 delete feishu-claude      # 删除进程（从 PM2 列表移除）
pm2 monit                     # 终端监控面板（CPU/内存）
```

---

### 第五步：验证

1. 在飞书中找到你的机器人，发送一条消息：`你好`
2. 如果一切正常，你会收到一张卡片回复，包含 Claude 的回复内容
3. 试试发送 `/help` 查看可用命令
4. 发送 `/status` 查看当前会话状态

#### 常见问题排查

| 问题 | 可能原因 | 解决方法 |
|------|---------|---------|
| 发消息没有回复 | 事件订阅地址不可达 | 检查 ngrok/nginx 是否正常，飞书后台能否验证通过 |
| 回复 "你没有权限" | `ALLOWED_USER_IDS` 设置了但不包含你 | 清空该变量或添加你的 open_id |
| 回复 "执行出错" | Anthropic API Key 无效 | 检查 `ANTHROPIC_API_KEY` 是否正确 |
| 群聊中不响应 | 没有 @机器人 | 群聊中需要 @机器人 才会触发 |
| 超时无回复 | 飞书 3 秒超时重试 | 本项目已异步处理，检查服务日志 |

## 技术栈

- **Runtime**: Node.js 18+ / TypeScript 5
- **HTTP**: Express
- **飞书 SDK**: @larksuiteoapi/node-sdk（WebSocket 长连接 + API 调用）
- **Claude Agent SDK**: @anthropic-ai/claude-agent-sdk (官方 SDK)
- **日志**: pino
- **进程管理**: PM2 (生产环境)

---

## 附录：HTTP Webhook 模式

如果你的生产环境有固定公网域名和 HTTPS 证书，可以使用传统的 HTTP Webhook 模式替代 WebSocket 长连接。

### 切换方式

在 `.env` 中设置：

```bash
FEISHU_EVENT_MODE=webhook
FEISHU_ENCRYPT_KEY=xxxxxxxxxxxx        # webhook 模式需要
FEISHU_VERIFY_TOKEN=xxxxxxxxxxxx       # webhook 模式需要
```

### 飞书后台配置

> **注意先后顺序**：填写回调地址时，飞书会立刻发送一个 challenge 验证请求。你必须**先部署好服务并确保地址可访问**，然后再来飞书后台配置。

1. 确保服务已部署且公网可访问（见第三步、第四步）
2. 飞书后台 → **「事件与回调」** → 选择 **「将事件发送至开发者服务器」**
3. **请求地址**填入：`https://your-domain.com/feishu/webhook`
   - 填入后飞书立刻发送 challenge 请求，本项目会自动响应
4. 记录页面上的 **Encrypt Key** 和 **Verification Token**，填入 `.env`
5. 添加事件 `im.message.receive_v1`

### 两种模式对比

| | WebSocket 长连接（默认） | HTTP Webhook |
|---|---|---|
| 公网 IP / 域名 | 不需要 | 需要 |
| HTTPS 证书 | 不需要 | 需要 |
| 回调地址 + challenge | 不需要 | 需要 |
| Encrypt Key / Verify Token | 不需要 | 需要 |
| 适用场景 | 开发/测试/内网 | 生产环境 |

## License

MIT
