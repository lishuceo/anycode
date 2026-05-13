---
name: maker-chats
description: "根据 Maker App ID 拉取该应用的 chat 列表，并生成可直接打开的 maker/fuping URL 表格。当用户提供 Maker App ID（UUID 形式，如 99b00f3e-e64a-455a-b000-9ec2c95297d7）并想查看该应用下所有 chat 会话、复盘历史对话、获取带 bypassAuth 的直达链接时使用。默认先查生产，生产无数据时回落到 fuping；也可显式指定 prod/fuping/both。用法：app_id [prod|fuping|both]"
---

# Maker Chats

根据 Maker App ID 拉取生产或 fuping 环境的 chat 列表，输出包含直达链接、标题、最后活跃时间的表格。

## API

| 环境 | API URL | 直达链接 base |
|------|---------|---------------|
| prod | `https://maker.taptap.cn/api/v1/gmtools/apps/<app_id>/chats` | `https://maker.taptap.cn/app/<app_id>?chatId=<chat_id>&bypassAuth=true` |
| fuping | `https://fuping.agnt.xd.com/api/v1/gmtools/apps/<app_id>/chats` | `https://fuping.agnt.xd.com/app/<app_id>?chatId=<chat_id>&bypassAuth=true` |

**分页参数**：`?limit=<N>&offset=<M>`。响应顶层 `hasMore: true` 表示还有下一页。默认页大小 `limit=50`。

无需鉴权，直接 GET。响应示例：

```json
{
  "appId": "99b00f3e-e64a-455a-b000-9ec2c95297d7",
  "limit": 20,
  "offset": 0,
  "hasMore": false,
  "chats": [
    {
      "id": "6825614d-1ad0-4084-9cb0-6acc7212e285",
      "title": "类似霓虹深渊的游戏...",
      "lastActivity": "2026-05-11T13:12:19.062Z"
    }
  ]
}
```

## 执行步骤

### 1. 解析输入

从 `$ARGUMENTS` 或用户消息中提取：

- `app_id`：UUID 格式（必须）。如未提供则询问用户。
- 环境：`prod` / `fuping` / `both`。**未指定时默认行为：先查 prod，命中则只展示 prod；prod 无数据（chats 为空、404 Not Found 或请求失败）时再查 fuping。** 用户显式指定时按指定执行（`both` 才并行两个环境）。

### 2. 查询 chats（按需翻页）

**单次只拉一页**。接口虽支持分页，但一页通常足够使用，不要循环抓取——等用户明确要下一页时再翻。

**默认（fallback）**：先单独查 prod 第一页，若无数据则查 fuping 第一页。

```bash
curl -s 'https://maker.taptap.cn/api/v1/gmtools/apps/<app_id>/chats?limit=20&offset=0'
# 若响应为 {"error":"Not Found"} / 网络失败 / chats 为空 → 再查 fuping
curl -s 'https://fuping.agnt.xd.com/api/v1/gmtools/apps/<app_id>/chats?limit=20&offset=0'
```

**显式 `both`**：并行调两个环境的第一页。

**显式 `prod` / `fuping`**：只调对应环境第一页，不回落。

判断"无数据"：响应非 JSON、缺少 `chats` 字段、`chats` 为空、HTTP 非 2xx。

**翻页**：当用户说"下一页"、"再来 N 条"、"翻到第 X 页"等时，复用上次命中的环境与 `limit`，按 `offset += limit` 调用：

```bash
curl -s '<base>/api/v1/gmtools/apps/<app_id>/chats?limit=<limit>&offset=<next_offset>'
```

跨轮记住：当前环境、`limit`、下一个 `offset`。如果用户切换 app_id，重置状态。

### 3. 输出结果

每个查询的环境输出一张表格。链接 base 必须**与查询环境一致**（fuping 的 chat 不能用 maker.taptap.cn 链接，反之亦然）。

```markdown
## Maker Chats — `<app_id>`

### Production (`maker.taptap.cn`) — N 条

| URL | Title | Last Activity |
|-----|-------|---------------|
| https://maker.taptap.cn/app/<app_id>?chatId=<chat_id>&bypassAuth=true | <title> | <lastActivity> |
| ... | ... | ... |

### Fuping (`fuping.agnt.xd.com`) — N 条

| URL | Title | Last Activity |
|-----|-------|---------------|
| https://fuping.agnt.xd.com/app/<app_id>?chatId=<chat_id>&bypassAuth=true | <title> | <lastActivity> |
```

排序：按 `lastActivity` 倒序（最近活跃在前）。

### 4. 注意事项

- `lastActivity` 保留 API 返回的原始 ISO 字符串，不做时区转换。
- 表格表头显示**当前页条数**与分页位置，例如 `Production (maker.taptap.cn) — 第 1 页 (offset 0, 20 条)`。
- 若 `hasMore=true`，在该环境表格下方追加一行提示：`> 还有更多 chat（hasMore=true），告诉我"下一页"继续翻。`
- 翻页结果同样按上述格式输出，标明当前 offset。
- 仅输出表格与必要说明，不要追加"是否需要还原项目"等额外建议（用户需要时会显式触发 `restore-project` 等技能）。
