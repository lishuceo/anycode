# OpenClaw 项目分析：Anywhere-Code 可借鉴的实现

> 分析日期: 2026-02-17
> OpenClaw 版本: 2026.2.16 (145k+ stars)
> Anywhere-Code 当前状态: 单渠道 (飞书) + Claude Agent SDK 桥接

---

## 一、两个项目的定位差异

| 维度 | OpenClaw | Anywhere-Code |
|------|----------|---------------|
| 定位 | 通用 AI 助手平台 | Claude Code 飞书桥接 |
| 渠道 | 40+ (Telegram/Discord/Slack/WhatsApp/Signal/iMessage...) | 仅飞书 |
| AI 后端 | 多模型 (Claude/GPT/Gemini) + Pi Agent 运行时 | 仅 Claude Agent SDK |
| 代码量 | ~52 个 src 子模块 + 40+ 扩展 | ~2000 行应用代码 |
| 架构 | WebSocket Gateway 控制平面 + 插件系统 | Express + 飞书 SDK 直连 |

**核心判断: Anywhere-Code 不需要也不应该成为 OpenClaw。** 但 OpenClaw 在以下几个维度的工程实现，值得有选择地借鉴。

---

## 二、高价值可借鉴实现

### 1. Channel 抽象层 (最高优先级)

**OpenClaw 的做法:**

```
extensions/telegram/  → ChannelPlugin 接口
extensions/discord/   → ChannelPlugin 接口
extensions/slack/     → ChannelPlugin 接口
...40+ 渠道
```

每个渠道是一个独立 npm workspace 包，通过 `package.json` 的 `openclaw.extensions` 字段注册:

```json
{
  "name": "@openclaw/telegram",
  "openclaw": { "extensions": ["./index.ts"] }
}
```

核心是 **ChannelPlugin 接口**:

```typescript
type ChannelPlugin = {
  id: string
  meta: ChannelMeta          // 元数据 (名称/图标/能力)
  messaging?: MessagingAdapter // 收发消息
  outbound?: OutboundAdapter   // 输出适配
  auth?: AuthAdapter           // 认证
  security?: SecurityAdapter   // 安全策略
  threading?: ThreadingAdapter // 话题/线程
  tools?: AgentTool[]          // 渠道专属工具
}
```

加上轻量的 **ChannelDock** 元数据注册:

```typescript
// dock.ts — 不加载任何重依赖，只声明能力
{ id: "telegram", chatTypes: ["direct","group"], blockStreaming: true, polls: true }
{ id: "discord",  chatTypes: ["direct","channel","thread"], inlineButtons: true }
```

**Anywhere-Code 现状的问题:**
- `FeishuClient`、`EventHandler`、`MessageBuilder` 全部硬编码飞书逻辑
- 添加 Slack/钉钉/企微需要大量复制粘贴

**建议借鉴方案:**

```
src/channels/
  types.ts           # ChannelAdapter 接口定义
  registry.ts        # 渠道注册表
  feishu/            # 飞书实现 (现有代码迁入)
    adapter.ts
    client.ts
    event-handler.ts
    message-builder.ts
  dingtalk/          # 未来: 钉钉
  wecom/             # 未来: 企业微信
  slack/             # 未来: Slack
```

核心接口 (精简版，不需要 OpenClaw 那么庞大):

```typescript
interface ChannelAdapter {
  id: string
  // 接收消息 → 统一格式
  onMessage(raw: unknown): IncomingMessage | null
  // 发送文本
  sendText(target: MessageTarget, text: string): Promise<void>
  // 发送进度卡片 (可选)
  sendProgress?(target: MessageTarget, status: ProgressStatus): Promise<void>
  // 更新已发送消息 (可选)
  updateMessage?(messageId: string, content: unknown): Promise<void>
}

interface IncomingMessage {
  channelId: string
  chatId: string
  userId: string
  text: string
  threadId?: string
  mentions?: string[]
}
```

**工作量估计: 1-2 天重构现有飞书代码到此结构。** 之后添加新渠道只需实现 `ChannelAdapter`。

---

### 2. 会话路由与 Session Key 组合 (高优先级)

**OpenClaw 的做法:**

```typescript
// 会话 key 格式: agent:{agentId}:{mainKey}
// mainKey = channel:account:peer (确定性、层次化)
// 支持多种 DM scope 模式:
//   main         → 所有 DM 共享一个会话
//   per-peer     → 每个联系人独立会话
//   per-channel-peer → 跨渠道同一联系人独立
```

Session key 设计特点:
- **确定性**: 相同输入总是生成相同 key (重启后恢复)
- **归一化**: 字母数字 + 连字符，最长 64 字符
- **层次化**: 支持从 key 反向解析出 agent/channel/user

**Anywhere-Code 现状:**

```typescript
// 简单拼接: chatId (群聊) 或 chatId:userId (私聊)
const key = this.makeKey(chatId, userId);
```

**建议借鉴:**
- 当前 key 方案在单渠道下够用
- **但一旦加入第二个渠道，必须在 key 中包含 channel 标识**
- 建议预留: `{channel}:{chatId}:{userId}` 格式
- 保持归一化 (去掉特殊字符，限制长度)

---

### 3. 插件式 MCP 工具注册 (中等优先级)

**OpenClaw 的做法:**

工具通过 Plugin SDK 注册，每个插件可以声明自己的 Agent 工具:

```typescript
type ChannelPlugin = {
  tools?: ChannelAgentTool[]   // 渠道贡献的工具
}
```

工具策略管道 (composable):

```typescript
applyToolPolicyPipeline([
  globalPolicy,        // 全局配置
  agentPolicy,         // 当前 agent 策略
  groupPolicy,         // 当前群组策略
  senderPolicy,        // 当前用户策略
  workspaceGuard,      // 工作区限制
])
```

**Anywhere-Code 现状:**
- 只有一个 `setup_workspace` MCP 工具
- 工具权限是全局 `canUseTool: () => ({ behavior: 'allow' })`

**建议借鉴:**
- 将 MCP 工具注册改为声明式，方便扩展:

```typescript
// src/tools/registry.ts
const tools = [
  createWorkspaceTool(),     // 现有
  createSearchTool(),        // 未来: 代码搜索
  createDeployTool(),        // 未来: 部署
];

// 注入到 executor
mcpServers: { 'tool-registry': createToolRegistry(tools) }
```

- 工具权限从全部放行改为 **按类别策略**:

```typescript
canUseTool: async (toolName, input) => {
  if (DANGEROUS_TOOLS.has(toolName)) {
    return { behavior: 'deny', message: '需要管理员确认' };
  }
  return { behavior: 'allow' };
}
```

---

### 4. 混合记忆系统 (中等优先级，长期)

**OpenClaw 的做法:**

```
Memory System
├── Vector Search (sqlite-vec, embeddings)
├── BM25 Full-text Search
├── Hybrid Ranking (configurable weights)
├── MMR Reranking (多样性)
├── Query Expansion (多语言关键词)
├── MEMORY.md 文件监听 + 增量同步
└── Temporal Decay (时间衰减)
```

- 支持多种 embedding 提供商: OpenAI / Gemini / Voyage / 本地 llama
- 每个 agent 独立记忆索引
- 优雅降级: embedding 失败 → 退回纯 BM25

**Anywhere-Code 现状:**
- 仅依赖 Claude Agent SDK 的 `resume` 参数续接会话
- 无跨会话记忆
- 无文档/知识库检索

**建议借鉴 (分阶段):**

**Phase 1 — 会话摘要持久化 (低成本):**
```typescript
// 每次会话结束时，让 Claude 生成一句摘要
// 存入 SQLite sessions 表的 summary 字段
// 下次会话在 systemPrompt.append 中注入历史摘要
```

**Phase 2 — MEMORY.md 文件支持:**
```typescript
// 读取工作区的 MEMORY.md，注入到 system prompt
// Claude Agent SDK 的 settingSources: ['project'] 已支持 CLAUDE.md
// 额外追加项目级记忆
```

**Phase 3 — 向量检索 (可选):**
```typescript
// 如果需求明确，用 sqlite-vec 做简单 RAG
// 但注意: Claude Agent SDK 本身已有文件读取能力
// 大部分场景不需要独立 RAG
```

---

### 5. Hook / 事件系统 (中等优先级)

**OpenClaw 的做法:**

```typescript
// 事件驱动 hook 系统
type HookEvent =
  | "command:new"         // 新命令到达
  | "session:start"       // 会话开始
  | "session:end"         // 会话结束
  | "webhook:received"    // 外部 webhook
  | "tool:before"         // 工具调用前
  | "tool:after"          // 工具调用后

// Hook 来源
type HookSource =
  | "openclaw-bundled"    // 内置
  | "openclaw-managed"    // 平台管理
  | "openclaw-workspace"  // 工作区自定义
  | "openclaw-plugin"     // 插件提供

// Frontmatter 元数据 (requirements)
// bins: ["git", "docker"]    — 依赖的外部命令
// env: ["GITHUB_TOKEN"]      — 依赖的环境变量
// os: ["darwin"]              — 操作系统限制
```

**Anywhere-Code 可借鉴的简化版:**

```typescript
// src/hooks/types.ts
type HookEvent = 'message:received' | 'task:start' | 'task:complete' | 'task:error';

interface Hook {
  event: HookEvent
  handler: (context: HookContext) => Promise<void>
}

// 使用场景:
// - task:complete → 发送钉钉/飞书通知
// - task:error → 触发告警
// - message:received → 审计日志
// - task:start → 记录开始时间 (metrics)
```

**价值:** 不需要改核心代码就能扩展行为。当前的 `EventHandler` 是同步管道，加 hook 点成本很低。

---

### 6. Block Streaming (流式分块推送) (低优先级)

**OpenClaw 的做法:**

针对支持渐进式文本的渠道 (Telegram、Discord 等):
- 设置 `blockStreaming: true` + 最小字符数 + 空闲超时
- Claude 每输出一段文字就推送给用户，而非等全部完成
- 不同渠道有不同的 coalesce (合并) 策略

**Anywhere-Code 现状:**
- 等 Claude 全部执行完毕后一次性返回结果
- 进度通过 interactive card 状态更新 ("执行中...")
- 但实际文本内容不流式推送

**建议借鉴:**
- 利用 Claude Agent SDK 的 `onProgress` 回调:

```typescript
for await (const message of q) {
  if (message.type === 'assistant') {
    // 每累积 200 字符或 3 秒，更新一次飞书卡片
    accumulatedText += extractText(message);
    if (shouldFlush(accumulatedText, lastFlushTime)) {
      await feishuClient.updateCard(cardId, accumulatedText);
      lastFlushTime = Date.now();
    }
  }
}
```

- 飞书的 interactive card 支持 `update`，天然适合流式更新
- **注意:** 飞书 API 有速率限制，不能每秒更新，需要合理 coalesce

---

### 7. 安全模型 (DM Pairing) (按需)

**OpenClaw 的做法:**

```
默认模式: "pairing"
  1. 未知用户发消息 → 返回配对码
  2. 管理员执行: openclaw pairing approve <channel> <code>
  3. 用户加入 allowlist → 正常使用

开放模式: allowFrom: ["*"]
  - 需显式配置，不是默认值
```

**Anywhere-Code 现状:**
- `ALLOWED_USER_IDS` 环境变量，空 = 允许所有人
- 无配对流程

**建议借鉴:**
- 当部署到公开环境时，空 allowlist = 允许所有人 是危险的
- 可以添加简单的审批流:

```typescript
// 首次消息 → 通知管理员
// 管理员回复 /approve @user → 加入白名单
// 不需要 OpenClaw 那样复杂的 QR/配对码
```

---

## 三、不建议借鉴的部分

| OpenClaw 特性 | 不借鉴原因 |
|---------------|-----------|
| Pi Agent 运行时 | Anywhere-Code 直接用 Claude Agent SDK，更轻量更直接 |
| 多模型切换 | 项目定位就是 Claude Code 桥接，不需要 GPT/Gemini |
| Gateway WebSocket 控制平面 | 过度工程，单进程 Express 足够当前规模 |
| macOS/iOS/Android 原生 App | 完全不同的产品形态 |
| A2UI Canvas | UI 工作台，与 IM 桥接场景不符 |
| 完整 Plugin SDK (460+ 导出类型) | 太重，简化的 adapter 接口足够 |
| Cron 调度系统 | 当前无此需求 |
| 浏览器自动化 (Playwright) | Claude Agent SDK 自己管理工具 |

---

## 四、推荐实施路线图

```
Phase 1 — 渠道抽象 (1-2 天)
  ├── 定义 ChannelAdapter 接口
  ├── 将飞书代码迁入 src/channels/feishu/
  ├── 统一 IncomingMessage 类型
  └── Session key 加入 channel 前缀

Phase 2 — 工具策略 (0.5 天)
  ├── canUseTool 从全放行改为分类策略
  ├── MCP 工具注册改为声明式
  └── 添加危险工具拦截

Phase 3 — 流式卡片更新 (0.5 天)
  ├── 利用 onProgress 回调
  ├── 合并策略 (200字符 / 3秒)
  └── 飞书 card update API

Phase 4 — 事件 Hook (0.5 天)
  ├── 定义 4-5 个核心事件点
  ├── 简单的 hook 注册机制
  └── 内置: 审计日志 hook

Phase 5 — 会话记忆 (1 天)
  ├── 会话结束摘要
  ├── 摘要注入到新会话 system prompt
  └── MEMORY.md 支持

Phase 6 — 新渠道 (按需)
  ├── 钉钉 adapter
  ├── 企业微信 adapter
  └── Slack adapter
```

---

## 五、总结

OpenClaw 是一个成熟的、面向消费者的通用 AI 助手平台，Anywhere-Code 是一个聚焦的、面向开发者的 Claude Code 桥接工具。两者定位不同，但 OpenClaw 在**渠道抽象**、**工具策略管道**、**混合记忆搜索**三个方面的工程设计，对 Anywhere-Code 的后续演进有直接参考价值。

最核心的一条: **现在就做渠道抽象层**。当前只有飞书，但中国团队环境下钉钉和企微是必然需求。提前抽象的成本很低 (1-2 天)，事后补做的成本很高 (涉及所有已有代码的重构)。
