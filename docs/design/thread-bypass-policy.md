---
summary: "话题内消息是否触发 bot 响应的过滤策略：保守优先，多人话题强制 @mention"
related_paths:
  - src/feishu/event-handler.ts
  - src/feishu/thread-participants.ts
  - src/utils/thread-relevance.ts
last_updated: "2026-06-03"
---

# Thread Bypass Policy

群聊里 bot **默认**只对显式 `@bot` 的消息响应。但在飞书话题（thread）场景下，频繁要求用户每条都 @ 会很烦——所以加了若干"无 @ bypass"口子。

本文档描述：哪些消息可以走 bypass、哪些必须 @；以及"多人话题保守策略"的兜底逻辑。

## 触发响应的判断顺序

每条群聊消息按以下顺序判断（命中任何 return 就停止）：

```
1. 私聊或显式 @ 任意已知 bot → 放行
2. 群聊主聊天区（无 threadId） → 必须 @bot，否则 return
3. 话题内消息：
   3.1. 发送者不是 session 创建者 / owner → return
   3.2. 拉取话题最近 10 条历史，判断是否有"非 session 创建者的人类用户"
   3.3. 如果有 → 多人话题，return（必须 @bot 才回，不论消息类型）
   3.4. 如果没有 → 单人话题：
        - 图片/文档 → 直接放行
        - 文字 → 走 Qwen 语义判断（checkThreadRelevance）
```

代码入口：`src/feishu/event-handler.ts` 的 `handleMessageEvent`：

| 行号范围 | 模式 | 职责 |
|----------|------|------|
| 756-780 | 多 bot 模式 thread creator bypass | 话题创建者 bot 在话题里无需 @；多人话题里跳过 |
| 779-820 | 单 bot 模式 | 话题内 session 创建者 bypass；多人话题里跳过 |

## 「多人话题」的定义

一个话题被视为**多人话题**，当且仅当：
- 拉取话题最近 10 条消息（不含当前消息），其中存在 senderType === `'user'` 且 senderId 不等于 session 创建者的消息。
- 拉取失败时**保守默认为 true**（要求 @bot 才回）。

实现：`src/feishu/thread-participants.ts`：

| 函数 | 职责 |
|------|------|
| `hasOtherHumanInMessages(messages, sessionUserId, currentMessageId)` | 纯函数，便于单测 |
| `threadHasOtherHumanParticipant(client, threadId, chatId, sessionUserId, currentMessageId, limit=10)` | 异步 wrapper，调用飞书 API 拉历史 |

**bot 自己的历史消息不算第三方**（senderType === `'app'` 一律忽略）。

## 单 bot vs 多 bot 模式差异

| 维度 | 单 bot 模式 | 多 bot 模式 |
|------|-------------|-------------|
| 触发条件 | session 创建者发消息 | 当前 bot 是话题创建者 + 任何 bot 都没被 @ |
| 单人话题文字消息 | Qwen 语义判断 | Qwen 语义判断 |
| 单人话题图片/文档 | 直接放行 | 走 `shouldRespond`（实际要求 @bot） |
| 多人话题任何类型 | 不响应 | 不响应 |
| API 调用 | fetchRecentMessages 一次 | fetchRecentMessages 一次 |

## 设计决策

| 决策 | 理由 |
|------|------|
| 多人话题强制 @bot | 历史教训（话题 `omt_197a3379c4cf1bb7`）：session 创建者发图给第三人看，bot 自作多情冲上去回复。多人讨论里 bot 没法可靠判断"这条消息是给我还是给别人"，干脆要求显式信号 |
| fetchRecentMessages 失败默认 true | 保守优先。API 抖动时宁可让用户多 @ 一次，也不要在多人话题里乱接 |
| 多人判定基于"曾经有过"而非"最近 N 条" | 简单且语义清晰；话题一旦多人化就一直保持保守 |
| 不在 thread_session 表加持久标志 | 实时拉历史已经足够轻量（一次 API 调用），加 schema 字段反而需要 migration + 数据回填 |
| 单人话题保留 Qwen 文字判断 | session 创建者自言自语（如"翻车了气死"）不应触发 bot |
| `app` 类型消息不算第三方 | 同群其他 bot 的发言不应触发 multi-user 状态 |

## 测试覆盖

- `src/feishu/__tests__/thread-participants.test.ts`：纯函数 + 异步 wrapper + 失败 fallback
- `src/feishu/__tests__/event-handler.test.ts`：
  - `single-bot group image/doc @mention filtering` —— 单 bot 模式所有组合（图/文档/文字 × 多人/单人 × @/无 @）
  - `multi-bot thread creator bypass — multi-user filtering` —— 多 bot 模式 bypass 行为

## 历史背景

最初话题内 bypass 只有"session 创建者 + Qwen 语义判断"。后来发现：

1. 纯图片/文档消息没有文字可送进 Qwen → 退化成"直接放行" → 多人话题里被滥用
2. Qwen 判断在多人讨论里准确率下降（无法区分"是问我还是问另一个人"）

修复策略从"修补单点" 升级到"多人话题里干掉所有 bypass"。Qwen 仍然在**单人话题**里有用——例如 session 创建者发一条自言自语的消息（"翻车了气死"），Qwen 能判断这不是在跟 bot 说话。
