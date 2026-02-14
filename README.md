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
| **Claude Executor** | 管理 Claude Code 长连接进程 (双向流式 JSON) | 子进程 + stream-json 协议 |
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
Claude Executor 通过长连接进程执行
        │
        ├─ 持久进程: claude --print --input-format stream-json --output-format stream-json
        ├─ 通过 stdin 发送 JSON 消息
        ├─ 通过 stdout 接收流式 JSON 事件
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

### 4. Claude Code 调用方式 — 双向流式 JSON 长连接

本项目采用 Claude Code CLI 的**双向流式 JSON 模式**，这是最接近 SDK 级别的使用方式：

```bash
# 启动持久进程，通过 stdin/stdout 双向流式 JSON 通信
claude --print \
  --output-format stream-json \
  --input-format stream-json \
  --dangerously-skip-permissions
```

**工作原理：**

```
          stdin (JSON)                    stdout (JSON)
  ┌──────────────────┐            ┌───────────────────────┐
  │ {"type":          │            │ {"type":"system",...}  │
  │   "user_message", │ ────────► │ {"type":"assistant",...}│
  │   "content":"..." │            │ {"type":"tool_use",...}│
  │ }                 │            │ {"type":"result",...}  │
  └──────────────────┘            └───────────────────────┘
```

**为什么选择长连接模式而非每次 spawn 新进程：**

| 对比 | 每次 spawn 新进程 | 长连接持久进程 (本项目) |
|------|------------------|----------------------|
| 启动开销 | 每次 ~2-3s | 仅首次启动 |
| 对话上下文 | 需要 `--resume` 手动续接 | 进程自动维护上下文 |
| 流式输出 | 需要捕获 stdout | 天然的双向流式通信 |
| 多轮对话 | 每轮独立进程 | 单进程内多轮 |
| 资源占用 | 频繁创建/销毁进程 | 一个常驻进程 |

**核心代码 (简化)：**

```typescript
// 每个飞书会话对应一个持久的 Claude Code 子进程
const proc = spawn('claude', [
  '--print',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
], { cwd: workingDir });

// 发送用户消息 → stdin
proc.stdin.write(JSON.stringify({
  type: 'user_message',
  content: '帮我看看这个 bug'
}) + '\n');

// 接收流式事件 ← stdout (逐行 JSON)
proc.stdout.on('data', (chunk) => {
  // {"type":"assistant","content":"让我看看..."}
  // {"type":"tool_use","tool_name":"Read",...}
  // {"type":"result","result":"已修复!"}
});
```

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
│   │   ├── client.ts            # 飞书 API 客户端
│   │   ├── event-handler.ts     # 飞书事件处理
│   │   ├── message-builder.ts   # 消息/卡片构建器
│   │   └── types.ts             # 飞书相关类型定义
│   ├── claude/
│   │   ├── executor.ts          # Claude Code 执行器
│   │   ├── output-parser.ts     # 输出解析与格式化
│   │   └── types.ts             # Claude 相关类型定义
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

### 2. 安装 Claude Code

```bash
npm install -g @anthropic-ai/claude-code
claude  # 首次运行进行认证
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
- **Claude Code**: CLI 双向流式 JSON 长连接 (--input-format stream-json)
- **日志**: pino
- **进程管理**: PM2 (生产环境)

## License

MIT
