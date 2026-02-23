# Plan 1: 插件化渠道架构

## 目标

将当前硬编码的飞书集成抽象为插件化渠道架构，使未来扩展到 Telegram、Slack、Discord 等渠道时只需编写新的 Channel 插件，无需修改核心逻辑。

## 现状分析

当前 `src/feishu/` 模块与核心逻辑深度耦合：
- `event-handler.ts` 同时包含飞书事件解析 + 队列调度 + Claude 执行 + Pipeline 触发
- `client.ts` 直接被 `event-handler.ts`、`pipeline/runner.ts`、`approval.ts` 等多处引用
- `message-builder.ts` 构建飞书专用卡片 JSON
- 消息发送/接收、卡片构建、@mention 解析等全部绑定飞书

## 架构设计

### 分层结构

```
┌─────────────────────────────────────────────────┐
│                 Channel Plugins                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │  Feishu   │ │ Telegram │ │  Slack (future)  │ │
│  │  Plugin   │ │ (future) │ │                  │ │
│  └────┬─────┘ └────┬─────┘ └────────┬─────────┘ │
│       │             │                │           │
└───────┼─────────────┼────────────────┼───────────┘
        │             │                │
        ▼             ▼                ▼
┌─────────────────────────────────────────────────┐
│              Channel Adapter Interface            │
│  ChannelAdapter {                                │
│    sendText(target, text)                        │
│    sendCard(target, card: UnifiedCard)            │
│    updateCard(msgId, card)                       │
│    replyText(msgId, text)                        │
│    replyInThread(msgId, text)                    │
│    getUserName(userId)                           │
│  }                                               │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│                Core Engine                        │
│  - EventRouter (dispatch inbound → handler)      │
│  - TaskQueue (per-thread FIFO)                   │
│  - ClaudeExecutor (Agent SDK)                    │
│  - SessionManager (SQLite)                       │
│  - PipelineOrchestrator                          │
│  - CardBuilder (unified, channel-agnostic)       │
└─────────────────────────────────────────────────┘
```

### 核心接口定义

```typescript
// src/channel/types.ts

/** 统一的入站消息 */
export interface InboundMessage {
  /** 渠道类型标识 */
  channel: string;              // 'feishu' | 'telegram' | 'slack' | ...
  /** 渠道内的消息 ID */
  messageId: string;
  /** 渠道内的会话/群 ID */
  chatId: string;
  /** 渠道内的用户 ID */
  userId: string;
  /** 会话类型 */
  chatType: 'private' | 'group';
  /** 纯文本内容 (已清理 @mention) */
  text: string;
  /** 是否 @了机器人 */
  mentionedBot: boolean;
  /** 话题/线程标识 */
  threadId?: string;
  /** 回复链根消息 ID */
  rootId?: string;
}

/** 统一的卡片/富消息结构 */
export interface UnifiedCard {
  type: 'progress' | 'result' | 'pipeline_confirm' | 'pipeline_progress' | 'status' | 'error';
  title: string;
  color?: 'green' | 'red' | 'orange' | 'blue' | 'grey';
  sections: CardSection[];
  actions?: CardAction[];
}

export interface CardSection {
  type: 'text' | 'code' | 'divider' | 'fields';
  content?: string;
  language?: string;
  fields?: { label: string; value: string }[];
}

export interface CardAction {
  type: 'button';
  label: string;
  actionId: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
}

/** 渠道适配器接口 */
export interface ChannelAdapter {
  readonly channelType: string;

  // 消息发送
  sendText(chatId: string, text: string): Promise<string | undefined>;
  sendCard(chatId: string, card: UnifiedCard): Promise<string | undefined>;
  updateCard(messageId: string, card: UnifiedCard): Promise<boolean>;
  replyText(messageId: string, text: string): Promise<string | undefined>;
  replyInThread(messageId: string, text: string): Promise<string | undefined>;
  replyCardInThread(messageId: string, card: UnifiedCard): Promise<string | undefined>;

  // 用户信息
  getUserName(userId: string, chatId?: string): Promise<string | undefined>;
}

/** 渠道插件接口 */
export interface ChannelPlugin {
  readonly channelType: string;
  readonly adapter: ChannelAdapter;

  /** 启动渠道 (注册事件监听等) */
  start(onMessage: (msg: InboundMessage) => Promise<void>,
        onCardAction: (action: CardActionEvent) => Promise<Record<string, unknown>>): Promise<void>;
  /** 关闭渠道 */
  stop(): Promise<void>;
}
```

## 实施步骤

### Phase 1: 定义接口层 (不改动现有功能)

1. **创建 `src/channel/types.ts`**
   - 定义 `InboundMessage`, `UnifiedCard`, `ChannelAdapter`, `ChannelPlugin` 接口
   - 定义 `CardActionEvent` 类型

2. **创建 `src/channel/registry.ts`**
   - 实现 `ChannelRegistry` 类: `register(plugin)`, `get(type)`, `startAll()`, `stopAll()`

3. **创建 `src/channel/card-builder.ts`**
   - 将 `message-builder.ts` 中的业务逻辑拆分为渠道无关的 `UnifiedCard` 构建
   - 每种卡片类型返回 `UnifiedCard` 而非飞书 JSON

### Phase 2: 实现飞书插件

4. **创建 `src/channel/feishu/plugin.ts`**
   - 实现 `ChannelPlugin` 接口
   - 将当前 `server.ts` 中的 WebSocket/Webhook 模式启动逻辑迁入
   - 将 `event-handler.ts` 中的消息解析逻辑 (`parseMessage`) 迁入

5. **创建 `src/channel/feishu/adapter.ts`**
   - 实现 `ChannelAdapter` 接口
   - 包装现有 `feishu/client.ts` 的方法
   - 将 `UnifiedCard` 转换为飞书卡片 JSON (调用现有 `message-builder.ts`)

6. **创建 `src/channel/feishu/card-renderer.ts`**
   - 从 `message-builder.ts` 中提取飞书特定的卡片渲染逻辑
   - 输入 `UnifiedCard`，输出飞书卡片 JSON

### Phase 3: 重构核心逻辑

7. **重构 `src/feishu/event-handler.ts` → `src/core/message-handler.ts`**
   - 提取渠道无关的处理逻辑:
     - 用户权限检查 (`isUserAllowed`)
     - 危险命令检测 (`containsDangerousCommand`)
     - 斜杠命令分发 (`handleSlashCommand`)
     - 审批工作流 (`checkAndRequestApproval`)
     - Pipeline 文本确认
     - 队列调度 (`processQueue`)
     - Claude 任务执行 (`executeClaudeTask`)
   - 所有消息发送改为通过 `ChannelAdapter` 接口

8. **重构 `src/server.ts`**
   - 服务器只负责 Express (health check) + ChannelRegistry 启动
   - 不再直接引用飞书 SDK

9. **重构 `src/pipeline/runner.ts`**
   - 卡片更新改为通过 `ChannelAdapter` 接口
   - 不再直接引用 `feishuClient`

### Phase 4: 整理和测试

10. **更新 `src/index.ts`**
    - 根据配置注册对应的 Channel 插件
    - `config.channels` 新增 channel 类型配置

11. **迁移测试**
    - 现有 `feishu/__tests__/` 拆分为 channel 通用测试 + feishu 特定测试
    - 新增 `channel/__tests__/registry.test.ts`

12. **更新 `src/config.ts`**
    - 新增 `channels` 配置节 (保持向后兼容: 如果有 `FEISHU_APP_ID` 自动注册飞书插件)

## 文件变更清单

### 新增文件
```
src/channel/
├── types.ts              # 核心接口定义
├── registry.ts           # 插件注册表
├── card-builder.ts       # 渠道无关的卡片构建
├── feishu/
│   ├── plugin.ts         # 飞书 ChannelPlugin 实现
│   ├── adapter.ts        # 飞书 ChannelAdapter 实现
│   └── card-renderer.ts  # UnifiedCard → 飞书卡片 JSON
└── __tests__/
    └── registry.test.ts
```

### 重构文件
```
src/feishu/event-handler.ts  → 拆分为 src/core/message-handler.ts + feishu plugin
src/feishu/message-builder.ts → 拆分为 card-builder.ts + feishu/card-renderer.ts
src/feishu/client.ts          → 移入 src/channel/feishu/ (内部实现)
src/server.ts                 → 简化，不再直接引用飞书
src/pipeline/runner.ts        → 改用 ChannelAdapter 接口
src/index.ts                  → 增加 ChannelRegistry 初始化
src/config.ts                 → 增加 channels 配置
```

### 保持不变
```
src/claude/          # Agent SDK 层不受影响
src/workspace/       # 工作区管理不受影响
src/session/         # 会话管理接口不变 (chatId/userId 仍为 key)
src/pipeline/orchestrator.ts  # 编排逻辑不变
src/pipeline/reviewer.ts      # Review 逻辑不变
```

## 关键约束

1. **向后兼容**: 现有 `.env` 配置 (FEISHU_APP_ID 等) 继续工作，无需改动部署
2. **渐进式重构**: 每个 Phase 可独立提交，中间状态可运行
3. **不改 session key**: `chatId:userId` 保持不变，channel 类型作为前缀可选
4. **测试不断**: 每步重构后 `npx vitest run` 全部通过

## 预期收益

- 未来加 Telegram 渠道只需实现 `ChannelPlugin` + `ChannelAdapter`，~200 行代码
- 核心逻辑 (queue, executor, pipeline) 完全解耦于具体渠道
- 可同时运行多个渠道（同一个 Claude 后端服务多渠道消息）
