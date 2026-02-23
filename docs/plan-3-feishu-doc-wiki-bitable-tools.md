# Plan 3: 飞书文档/Wiki/多维表格 MCP 工具

## 目标

参考 OpenClaw 的飞书扩展 (`extensions/feishu/src/tools/`)，为 Claude Code 注入飞书文档 (Docx)、知识库 (Wiki)、云空间 (Drive)、多维表格 (Bitable) 的 MCP 工具，使 Claude 在执行任务时能直接读写飞书文档，实现 "飞书发消息 → Claude 读需求文档 → 修改代码 → 更新飞书文档" 的闭环。

## 现状分析

当前 `workspace/tool.ts` 已有 MCP 工具注入模式：
- 通过 `createSdkMcpServer()` 定义工具
- 工具 schema 使用 Zod 定义
- 每次 query 创建独立 MCP 实例（闭包绑定，避免并发问题）
- Claude Agent SDK 通过 `mcpServers` 参数注入

OpenClaw 的飞书工具采用 action-based dispatch 模式:
- 单个工具名 (如 `feishu_doc`) 包含多个 action (read/write/create/...)
- TypeBox schema 定义参数
- 复用飞书 SDK client

**我们的方案**: 复用相同的飞书 SDK (`@larksuiteoapi/node-sdk`，已有依赖)，以 MCP 工具形式注入，与现有 `setup_workspace` 工具共存。

## 工具清单

### 1. `feishu_doc` — 飞书文档操作

| Action | 说明 | 飞书 API |
|--------|------|----------|
| `read` | 读取文档内容 (返回纯文本/Markdown) | `docx.document.rawContent` |
| `write` | 覆写文档内容 (Markdown → Blocks) | `docx.documentBlockChildren.batchDelete` + `create` |
| `append` | 追加内容到文档末尾 | `docx.documentBlockChildren.create` |
| `create` | 创建新文档 | `docx.document.create` |
| `list_blocks` | 列出文档块结构 | `docx.documentBlock.list` |

### 2. `feishu_wiki` — 知识库操作

| Action | 说明 | 飞书 API |
|--------|------|----------|
| `list_spaces` | 列出可访问的知识库空间 | `wiki.space.list` |
| `list_nodes` | 列出空间内的页面节点 | `wiki.spaceNode.list` |
| `get_node` | 获取节点详情 | `wiki.space.getNode` |
| `create_node` | 创建新的 Wiki 页面 | `wiki.spaceNode.create` |

### 3. `feishu_drive` — 云空间操作

| Action | 说明 | 飞书 API |
|--------|------|----------|
| `list` | 列出文件夹内容 | `drive.file.list` |
| `info` | 获取文件/文件夹信息 | `drive.file.get` |
| `create_folder` | 创建文件夹 | `drive.file.createFolder` |

### 4. `feishu_bitable` — 多维表格操作

| Action | 说明 | 飞书 API |
|--------|------|----------|
| `list_tables` | 列出 Base 下的所有数据表 | `bitable.appTable.list` |
| `list_fields` | 列出数据表的字段定义 | `bitable.appTableField.list` |
| `list_records` | 查询记录 (支持筛选/排序) | `bitable.appTableRecord.list` |
| `get_record` | 获取单条记录 | `bitable.appTableRecord.get` |
| `create_record` | 新增记录 | `bitable.appTableRecord.create` |
| `update_record` | 更新记录 | `bitable.appTableRecord.update` |
| `delete_record` | 删除记录 | `bitable.appTableRecord.delete` |

## 架构设计

### MCP 工具注入方式

```
ClaudeExecutor.execute()
    │
    ├── createWorkspaceMcpServer()     ← 现有: setup_workspace
    │
    └── createFeishuToolsMcpServer()   ← 新增: feishu_doc, feishu_wiki, feishu_drive, feishu_bitable
         │
         └── 复用 feishuClient.raw (lark.Client)
              进行 API 调用
```

### 模块结构

```typescript
// src/feishu/tools/index.ts
export function createFeishuToolsMcpServer() {
  return createSdkMcpServer({
    name: 'feishu-tools',
    version: '1.0.0',
    tools: [
      feishuDocTool(),
      feishuWikiTool(),
      feishuDriveTool(),
      feishuBitableTool(),
    ],
  });
}
```

每个工具模块遵循统一模式：

```typescript
// src/feishu/tools/doc.ts
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { feishuClient } from '../client.js';

const docSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('read'),
    doc_token: z.string().describe('文档 token (从 URL /docx/XXX 中提取)'),
  }),
  z.object({
    action: z.literal('write'),
    doc_token: z.string().describe('文档 token'),
    content: z.string().describe('Markdown 内容 (覆写整个文档)'),
  }),
  z.object({
    action: z.literal('append'),
    doc_token: z.string().describe('文档 token'),
    content: z.string().describe('要追加的 Markdown 内容'),
  }),
  z.object({
    action: z.literal('create'),
    title: z.string().describe('文档标题'),
    folder_token: z.string().optional().describe('目标文件夹 token (可选)'),
  }),
  z.object({
    action: z.literal('list_blocks'),
    doc_token: z.string().describe('文档 token'),
  }),
]);

export function feishuDocTool() {
  return tool(
    'feishu_doc',
    '飞书文档操作。支持: read (读文档), write (覆写), append (追加), create (新建), list_blocks (列块)。',
    // Zod schema 展开为 flat parameters (SDK 限制)
    {
      action: z.enum(['read', 'write', 'append', 'create', 'list_blocks']).describe('操作类型'),
      doc_token: z.string().optional().describe('文档 token (从 URL /docx/XXX 中提取)'),
      content: z.string().optional().describe('Markdown 内容 (write/append 时必填)'),
      title: z.string().optional().describe('文档标题 (create 时必填)'),
      folder_token: z.string().optional().describe('目标文件夹 token (create 时可选)'),
    },
    async (args) => {
      // action dispatch + API 调用
    },
  );
}
```

## 实施步骤

### Phase 1: 基础设施

1. **创建 `src/feishu/tools/` 目录结构**
   ```
   src/feishu/tools/
   ├── index.ts       # createFeishuToolsMcpServer() 入口
   ├── doc.ts         # feishu_doc 工具
   ├── wiki.ts        # feishu_wiki 工具
   ├── drive.ts       # feishu_drive 工具
   ├── bitable.ts     # feishu_bitable 工具
   └── __tests__/
       ├── doc.test.ts
       ├── wiki.test.ts
       └── bitable.test.ts
   ```

2. **确认飞书 App 权限**
   - 文档读写: `docx:document`, `docx:document:readonly`
   - Wiki: `wiki:wiki`, `wiki:wiki:readonly`
   - 云空间: `drive:drive`, `drive:drive:readonly`
   - 多维表格: `bitable:app`, `bitable:app:readonly`
   - 这些权限需要在飞书开放平台后台配置

### Phase 2: 实现文档工具 (核心)

3. **实现 `src/feishu/tools/doc.ts`**

   - `readDoc(docToken)`:
     ```typescript
     const resp = await client.docx.document.rawContent({
       path: { document_id: docToken },
       params: { lang: 0 },  // 0 = 用户默认语言
     });
     // 返回纯文本内容
     ```

   - `writeDoc(docToken, markdownContent)`:
     1. 获取文档所有 block ID: `docx.documentBlock.list()`
     2. 删除所有子 block: `docx.documentBlockChildren.batchDelete()`
     3. 插入新内容 (Markdown → Block): 飞书不支持直接 Markdown 导入，
        需要解析 Markdown 转换为 Block 结构或使用 `docx.document.convert` (如果可用)
     4. 简化方案: 使用纯文本 block 插入（v1 先做这个）

   - `appendDoc(docToken, content)`:
     ```typescript
     await client.docx.documentBlockChildren.create({
       path: { document_id: docToken, block_id: docToken }, // page block
       data: { children: [{ block_type: 2, text: { elements: [{ text_run: { content } }] } }] },
     });
     ```

   - `createDoc(title, folderToken?)`:
     ```typescript
     const resp = await client.docx.document.create({
       data: { title, folder_token: folderToken },
     });
     ```

   - `listBlocks(docToken)`:
     ```typescript
     const resp = await client.docx.documentBlock.list({
       path: { document_id: docToken },
     });
     // 返回 block 树结构 (type, content, children)
     ```

### Phase 3: 实现 Wiki + Drive 工具

4. **实现 `src/feishu/tools/wiki.ts`**

   - `listSpaces()`: `wiki.space.list({ params: { page_size: 50 } })`
   - `listNodes(spaceId, parentNodeToken?)`: `wiki.spaceNode.list()`
   - `getNode(spaceId, nodeToken)`: `wiki.space.getNode()`
   - `createNode(spaceId, title, parentNodeToken?)`: `wiki.spaceNode.create()`

5. **实现 `src/feishu/tools/drive.ts`**

   - `listFiles(folderToken?)`: `drive.file.list()`
   - `getFileInfo(fileToken)`: `drive.file.get()` 或 `drive.file.taskCheck()`
   - `createFolder(name, parentToken?)`: `drive.file.createFolder()`

### Phase 4: 实现多维表格工具

6. **实现 `src/feishu/tools/bitable.ts`**

   - `listTables(appToken)`: `bitable.appTable.list()`
   - `listFields(appToken, tableId)`: `bitable.appTableField.list()`
   - `listRecords(appToken, tableId, filter?, sort?, pageSize?)`:
     ```typescript
     const resp = await client.bitable.appTableRecord.list({
       path: { app_token: appToken, table_id: tableId },
       params: {
         filter,
         sort: sort ? JSON.stringify(sort) : undefined,
         page_size: pageSize || 100,
       },
     });
     ```
   - `getRecord(appToken, tableId, recordId)`: `bitable.appTableRecord.get()`
   - `createRecord(appToken, tableId, fields)`: `bitable.appTableRecord.create()`
   - `updateRecord(appToken, tableId, recordId, fields)`: `bitable.appTableRecord.update()`
   - `deleteRecord(appToken, tableId, recordId)`: `bitable.appTableRecord.delete()`

### Phase 5: 集成到 Claude Executor

7. **修改 `src/claude/executor.ts`**

   ```typescript
   // 在 execute() 方法中:
   import { createFeishuToolsMcpServer } from '../feishu/tools/index.js';

   // MCP 服务器列表
   const mcpServers: Record<string, ReturnType<typeof createSdkMcpServer>> = {};

   // 工作区工具 (现有)
   if (!disableWorkspaceTool) {
     mcpServers['workspace-manager'] = createWorkspaceMcpServer(onWorkspaceChangedWrapped);
   }

   // 飞书工具 (新增，配置开关控制)
   if (config.feishu.appId && config.feishu.tools?.enabled !== false) {
     mcpServers['feishu-tools'] = createFeishuToolsMcpServer();
   }
   ```

8. **更新 system prompt**

   在 `buildWorkspaceSystemPrompt()` 中增加飞书工具使用指引：

   ```
   ## 飞书文档工具

   你有以下飞书工具可用 (通过 mcp__feishu-tools__feishu_xxx 调用):

   - **feishu_doc**: 读写飞书文档。用户可能在消息中提供文档链接 (如 https://xxx.feishu.cn/docx/TOKEN)，从 URL 中提取 doc_token 后使用。
   - **feishu_wiki**: 查看知识库内容。
   - **feishu_drive**: 浏览云空间文件。
   - **feishu_bitable**: 读写多维表格数据。

   使用场景:
   - 用户说"看一下这个文档" + 提供链接 → 使用 feishu_doc read
   - 用户说"把方案写到文档里" → 使用 feishu_doc write/create
   - 用户说"查一下知识库中的 API 文档" → 使用 feishu_wiki
   - 用户说"更新一下需求表" → 使用 feishu_bitable
   ```

### Phase 6: 配置与权限

9. **更新 `src/config.ts`**

   ```typescript
   feishu: {
     // ... 现有配置
     tools: {
       enabled: true,           // 总开关
       doc: true,               // 文档工具
       wiki: true,              // Wiki 工具
       drive: true,             // 云空间工具
       bitable: true,           // 多维表格工具
     },
   },
   ```

   环境变量:
   ```
   FEISHU_TOOLS_ENABLED=true
   FEISHU_TOOLS_DOC=true
   FEISHU_TOOLS_WIKI=true
   FEISHU_TOOLS_DRIVE=true
   FEISHU_TOOLS_BITABLE=true
   ```

10. **只读模式下的工具权限**

    在 `canUseTool` 回调中，对只读用户:
    - `feishu_doc` read / list_blocks → 允许
    - `feishu_doc` write / append / create → 拒绝
    - `feishu_wiki` list/get → 允许
    - `feishu_wiki` create → 拒绝
    - `feishu_bitable` list/get → 允许
    - `feishu_bitable` create/update/delete → 拒绝

    实现: 在 `canUseTool` 中检查工具名 + input.action:

    ```typescript
    if (readOnly && toolName.includes('feishu')) {
      const action = inputObj.action as string;
      const writeActions = ['write', 'append', 'create', 'update', 'delete', 'move', 'rename'];
      if (writeActions.includes(action)) {
        return { behavior: 'deny', message: '只读模式下不能修改飞书文档' };
      }
    }
    ```

### Phase 7: 测试

11. **单元测试**

    - Mock `feishuClient.raw` 的各种 API 方法
    - 测试每个 action 的参数校验和返回格式
    - 测试错误处理 (token 无效、权限不足等)

12. **集成测试 (可选)**

    - 需要真实飞书 App 凭据
    - 使用 `FEISHU_LIVE_TEST=1` 环境变量控制
    - 创建测试文档 → 读取 → 修改 → 删除

## 文件变更清单

### 新增文件
```
src/feishu/tools/
├── index.ts              # MCP 服务器创建入口
├── doc.ts                # 文档操作工具
├── wiki.ts               # 知识库操作工具
├── drive.ts              # 云空间操作工具
├── bitable.ts            # 多维表格操作工具
└── __tests__/
    ├── doc.test.ts
    ├── wiki.test.ts
    ├── drive.test.ts
    └── bitable.test.ts
```

### 修改文件
```
src/claude/executor.ts    # 注入 feishu-tools MCP 服务器
src/config.ts             # 新增 feishu.tools 配置
.env.example              # 新增工具开关环境变量
```

## URL Token 解析辅助

Claude 在消息中收到飞书链接时需要解析出 token:

```
https://xxx.feishu.cn/docx/ABC123          → doc_token: ABC123
https://xxx.feishu.cn/wiki/ABC123          → node_token: ABC123 (wiki 页面本质是 docx)
https://xxx.feishu.cn/drive/folder/ABC123  → folder_token: ABC123
https://xxx.feishu.cn/base/ABC123          → app_token: ABC123
```

在 system prompt 中提示 Claude 如何从 URL 提取 token 即可，无需代码层面处理。

## 关键约束

1. **无新依赖**: 复用已有的 `@larksuiteoapi/node-sdk`
2. **配置可关闭**: `FEISHU_TOOLS_ENABLED=false` 完全不注入工具（适用于不需要文档能力的部署）
3. **不影响现有功能**: 工具以额外 MCP 服务器形式注入，`workspace-manager` 不受影响
4. **错误隔离**: 飞书 API 调用失败只影响该工具调用，不影响 Claude Code 整体执行

## 预期收益

- Claude 可以直接读取飞书需求文档，无需用户复制粘贴
- Claude 可以将方案/报告写入飞书文档，方便团队协作
- Claude 可以操作多维表格（如 bug tracker、需求管理），实现自动化工作流
- 飞书 → Claude Code → 飞书 的闭环体验
