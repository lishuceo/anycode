---
summary: "话题内消息是否触发 bot 响应的过滤策略：单人放行 / 多人强制 @mention"
related_paths:
  - src/feishu/event-handler.ts
  - src/feishu/thread-participants.ts
last_updated: "2026-06-03"
---

# Thread Bypass Policy

群聊里 bot **默认**只对显式 `@bot` 的消息响应。但在飞书话题（thread）场景下，频繁要求用户每条都 @ 会很烦——所以加了"无 @ bypass"口子。

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
   3.4. 如果没有 → 单人话题：图片/文档/文字 全部直接放行
```

代码入口：`src/feishu/event-handler.ts` 的 `handleMessageEvent`。

| 模式 | 职责 |
|------|------|
| 多 bot 模式 thread creator bypass | 话题创建者 bot 在单人话题里无需 @；多人话题里跳过 |
| 单 bot 模式 | 话题内 session 创建者在单人话题里无需 @；多人话题里跳过 |

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
| 单人话题任何类型 | 直接放行 | 直接放行 |
| 多人话题任何类型 | 不响应 | 不响应 |
| API 调用 | fetchRecentMessages 一次 | fetchRecentMessages 一次 |

## 设计决策

| 决策 | 理由 |
|------|------|
| 多人话题强制 @bot | 历史教训（话题 `omt_197a3379c4cf1bb7`）：session 创建者发图给第三人看，bot 自作多情冲上去回复。多人讨论里 bot 没法可靠判断"这条消息是给我还是给别人"，干脆要求显式信号 |
| 单人话题直接放行（不再用 Qwen 二次判断） | 话题本身就是 user vs bot 的对话载体，单人话题里 session 创建者发的消息基本就是冲 bot 来的。早期"自言自语保留 Qwen 文字判断"的设计反而引入误判（话题 `omt_197a5d56cc92dbe9`：「不用新分支，但是文档需要更新」被 Qwen 判为"不是跟 bot 说话"，因为 Qwen 拿不到上下文） |
| fetchRecentMessages 失败默认 true | 保守优先。API 抖动时宁可让用户多 @ 一次，也不要在多人话题里乱接 |
| 多人判定基于"曾经有过"而非"最近 N 条" | 简单且语义清晰；话题一旦多人化就一直保持保守 |
| 不在 thread_session 表加持久标志 | 实时拉历史已经足够轻量（一次 API 调用），加 schema 字段反而需要 migration + 数据回填 |
| `app` 类型消息不算第三方 | 同群其他 bot 的发言不应触发 multi-user 状态 |

## 测试覆盖

- `src/feishu/__tests__/thread-participants.test.ts`：纯函数 + 异步 wrapper + 失败 fallback
- `src/feishu/__tests__/event-handler.test.ts`：
  - `single-bot group image/doc @mention filtering` —— 单 bot 模式所有组合（图/文档/文字 × 多人/单人 × @/无 @）
  - `multi-bot thread creator bypass — multi-user filtering` —— 多 bot 模式 bypass 行为

## 历史演进

1. **v1**：话题内 bypass 只有"session 创建者 + Qwen 语义判断（文字）"。
2. **v2**：发现纯图片/文档消息没有文字可送进 Qwen → 退化成"直接放行" → 多人话题里被滥用。
3. **v3**：引入"多人话题保守策略" —— 多人话题里干掉所有 bypass。Qwen 仍然保留在单人话题文字消息上。
4. **v4（当前）**：发现 Qwen 在单人话题里也是累赘 —— 它拿不到对话上下文，把延续上文的简短反馈（如「不用新分支，但是文档需要更新」）误判成"不是跟 bot 说话"。话题本就是 user vs bot 的对话载体，单人话题里没必要二次判断，直接放行。
