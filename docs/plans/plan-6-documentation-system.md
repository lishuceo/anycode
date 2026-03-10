---
summary: "文档维护体系建设：目录重组 + front matter 规范 + 文档 CI"
status: in_progress
owner: lishuceo
last_updated: "2026-03-10"
read_when:
  - 新建或修改 docs/ 目录下的文件
  - 配置文档相关的 CI 检查
  - 调整文档目录结构
---

# Plan 6: 文档维护体系建设

## 目标

参考 OpenClaw 的文档维护实践，为 anywhere-code 建立结构化的文档体系，覆盖三个层面：

1. **用户文档** — 部署指南、配置说明、API 参考（面向使用者）
2. **开发实施计划** — 指导 coding agent 持续执行的临时文档（做完即弃）
3. **文档质量自动化** — CI 自动检查格式、链接、拼写

## 现状分析

| 维度 | 现状 | 问题 |
|------|------|------|
| 用户文档 | 仅 `README.md` | 内容越来越长，不便查找；无法按主题导航 |
| 开发计划 | `docs/plan-*.md` 平铺 | 无 front matter 元数据，agent 无法自动发现该读哪个计划 |
| 文档 CI | 无 | `docs/**` 变更直接跳过 CI，无格式/链接检查 |
| 国际化 | 无 | 暂不需要，但预留扩展空间 |

## 改造方案

### Phase 1: 开发计划文档规范化（立即可做）

**目标**: 让 coding agent 自动发现并遵循相关计划。

#### 1.1 目录重组

```
docs/
├── plans/           # 活跃的实施计划（做完可删）
│   ├── plan-1-channel-plugin-architecture.md
│   ├── plan-2-structured-config-hot-reload.md
│   ├── ...
│   └── plan-6-documentation-system.md  ← 本文件
├── design/          # 长期架构设计文档
│   ├── pipeline-design.md
│   ├── routing-agent.md
│   └── thread-session-mapping.md
├── research/        # 调研分析（参考用）
│   ├── openclaw-analysis.md
│   └── openclaw-multi-agent-customization.md
└── user/            # 用户文档（Phase 2）
```

#### 1.1.1 设计决策：为什么这么分（与 OpenClaw 对比）

**OpenClaw 的目录结构：**

```
docs/
├── experiments/
│   ├── plans/       # 临时实施计划
│   ├── proposals/   # 社区设计提案
│   └── research/    # 调研
├── refactor/        # 跨 PR 重构计划
├── design/          # 集成设计
├── channels/        # 用户文档（200+ 页）
├── cli/             # 用户文档
└── ...              # 30+ 用户文档子目录
```

**核心区别：项目阶段和规模决定结构。**

| 维度 | OpenClaw | anywhere-code |
|------|----------|---------------|
| 文档总量 | 200+ 页用户文档 + 20+ 内部文档 | 14 个内部文档，无用户文档站 |
| 贡献者模式 | 开源社区，需要隔离防止内部文档被发布 | 团队内部 + coding agent |
| 文档站 | Mintlify，和内部文档混在同一个 `docs/` | 不存在 |
| 提案流程 | 社区有 proposals 流程，需要 `proposals/` 子目录 | 无，所有计划都是内部的 |

**我们做了什么精简，以及为什么：**

| 决策 | 理由 |
|------|------|
| **不套 `experiments/` 隔离层** | OpenClaw 需要 `experiments/` 是因为用户文档和内部文档共存于 `docs/`，Mintlify 会发布 `docs/` 下的所有内容，必须用命名空间隔离。我们没有文档站，不存在这个问题 |
| **不建 `proposals/` 子目录** | OpenClaw 有社区提案流程（外部贡献者提 proposal → 讨论 → 升级为 plan）。我们是内部团队，想法直接写成 plan 开干 |
| **不建 `refactor/` 子目录** | OpenClaw 的 `refactor/` 存放跨多个 PR 的长期重构计划（6 个文件）。我们规模小，长期设计放 `design/` 即可，不需要再细分 |
| **`plans/` 和 `design/` 分开** | 生命周期不同：plans 是临时的（做完删），design 是长期的（持续维护）。对 agent 来说，"扫描 `plans/` 找活跃任务"比"扫描全部 `docs/` 再按 status 过滤"更精准，省 token |
| **`research/` 独立** | 调研文档是"只读参考"，和"要执行的计划"、"要维护的设计"性质都不同。分开后 agent 不会误把调研当成待执行任务 |

**优缺点对比：**

| | OpenClaw 方案 | 我们的方案 |
|---|---|---|
| **优点** | 成熟完善，支撑 200+ 页文档和社区协作，经过大规模验证 | 简单直接，匹配当前 14 文件的规模，agent 扫描路径精准 |
| **缺点** | 对 14 个文件的小项目过度设计（4 层嵌套），增加认知负担 | 未来如果上文档站，需要重新考虑隔离策略（加 `experiments/` 层或将 `plans/` 移到 `docs/` 外） |
| **适合** | 大型开源项目（100+ 文档，有社区贡献者） | 10~50 文档的内部项目（团队 + agent 协作） |

**风险与应对：**

- **边界模糊问题**：`ci-improvements.md` 这类文件可能既有"计划"属性又有"设计"属性。应对：看生命周期——如果做完会删，放 `plans/`；如果会长期维护，放 `design/`
- **Phase 2 上文档站后的隔离**：届时 `plans/` `design/` `research/` 需要被文档框架排除。Mintlify 用 `docs.json` 的 navigation 控制，不在导航中的文件不会发布；VitePress 用 `.vitepress/config.ts` 的 `srcExclude` 排除。两种方案都不需要改目录结构

#### 1.2 为计划文件添加 YAML front matter

```yaml
---
summary: "飞书文档/Wiki/多维表格 MCP 工具集成"
status: completed           # draft | in_progress | completed
owner: lishuceo
last_updated: "2026-03-10"
read_when:
  - 开发飞书文档相关的 MCP 工具
  - 修改工具注入逻辑
---
```

关键字段说明：

| 字段 | 用途 |
|------|------|
| `summary` | 一句话描述，agent 扫描时快速判断相关性 |
| `status` | `draft` → `in_progress` → `completed`（completed 后可归档或删除）|
| `read_when` | **核心字段**：告诉 agent 在什么场景下应该读这个文档 |
| `owner` | 负责人的 Git ID |

#### 1.3 在 CLAUDE.md 中添加指引

```markdown
## 开发计划文档

- 实施计划放在 `docs/plans/`，完成后删除或标记 `status: completed`
- 开始新任务前，扫描 `docs/plans/*.md` 的 front matter，读取与当前任务相关的计划
- 新建计划必须包含 `summary`、`status`、`read_when` 字段
```

---

### Phase 2: 用户文档站搭建（建议优先级：中）

**目标**: 将 README.md 拆分为结构化的文档站。

#### 2.1 框架选择

| 方案 | 优点 | 缺点 |
|------|------|------|
| **Mintlify**（推荐） | OpenClaw 同款，Git-push 即部署，美观 | 需付费（开源项目免费） |
| VitePress | 免费，Vue 生态，中文友好 | 需自建部署 |
| Docusaurus | React 生态，功能全 | 较重 |

#### 2.2 建议目录结构

```
docs/user/
├── docs.json         # Mintlify 配置（或对应框架配置）
├── start/
│   ├── getting-started.md
│   ├── prerequisites.md
│   └── quick-deploy.md
├── configuration/
│   ├── environment.md
│   ├── agents.md
│   └── security.md
├── features/
│   ├── feishu-tools.md
│   ├── workspace.md
│   ├── memory.md
│   └── multi-agent.md
├── reference/
│   ├── mcp-tools.md
│   └── api.md
└── troubleshooting.md
```

#### 2.3 从 README.md 迁移

- README.md 精简为项目简介 + 快速开始 + 文档站链接
- 详细内容迁移到 `docs/user/` 各子页面

---

### Phase 3: 文档质量自动化（建议优先级：中）

**目标**: CI 自动检查文档质量，防止死链、格式混乱。

#### 3.1 工具链

| 层级 | 工具 | 作用 | npm 脚本 |
|------|------|------|----------|
| 格式化 | Prettier（`.md`）| 统一 Markdown 格式 | `docs:format` |
| Lint | markdownlint-cli2 | 检查 Markdown 规范 | `docs:lint` |
| 链接审计 | 自研脚本或 lychee | 检测内部死链 | `docs:check-links` |
| 拼写检查 | codespell | 检测常见拼写错误 | `docs:spellcheck` |
| 综合 | 以上组合 | CI 入口 | `docs:check` |

#### 3.2 CI 集成

在 `ci.yml` 中新增 docs-scope 检测：

```yaml
docs-scope:
  runs-on: ubuntu-latest
  outputs:
    docs_only: ${{ steps.check.outputs.docs_only }}
    docs_changed: ${{ steps.check.outputs.docs_changed }}
  steps:
    - uses: actions/checkout@v4
    - id: check
      run: |
        # 检测是否为纯文档变更
        CHANGED=$(git diff --name-only ${{ github.event.before }} ${{ github.sha }})
        DOCS_ONLY=true
        for f in $CHANGED; do
          [[ "$f" == docs/* || "$f" == *.md ]] || { DOCS_ONLY=false; break; }
        done
        echo "docs_only=$DOCS_ONLY" >> "$GITHUB_OUTPUT"
        echo "docs_changed=$(echo "$CHANGED" | grep -qE '^docs/|\.md$' && echo true || echo false)" >> "$GITHUB_OUTPUT"

check-docs:
  needs: [docs-scope]
  if: needs.docs-scope.outputs.docs_changed == 'true'
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - run: npm run docs:check
```

- 纯文档 PR → 跳过 build/test，只跑 `docs:check`（快速通道）
- 混合 PR → 正常跑 build/test + `docs:check`

---

### Phase 4: Agent 文档自动发现（建议优先级：低）

**目标**: 类似 OpenClaw 的 `docs:list`，让 agent 开始任务前自动定位该读哪些文档。

实现一个 `scripts/docs-list.mjs`：

```javascript
// 扫描 docs/plans/*.md 的 front matter
// 输出: { path, summary, status, read_when }
// agent 据此决定是否 read 某个计划文件
```

在 CLAUDE.md 中加入：

```markdown
开始复杂任务前，先运行 `node scripts/docs-list.mjs` 查看相关计划文档。
```

---

## 实施优先级

| Phase | 内容 | 难度 | 建议时间 |
|-------|------|------|----------|
| **1** | 计划文档规范化 + 目录重组 | 低 | 可立即执行 |
| **2** | 用户文档站搭建 | 中 | 功能稳定后 |
| **3** | 文档 CI 自动化 | 中 | 与 Phase 2 同步 |
| **4** | Agent 文档自动发现 | 低 | Phase 1 完成后 |

## 非目标

- 国际化翻译（当前用户全部为中文用户，不需要）
- 文档站 SEO 优化（内部工具，不需要公开推广）
- API 文档自动生成（TypeDoc 等，代码注释覆盖率不足，投入产出比低）
