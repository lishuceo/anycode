# CI/CD 改进方案

## 1. 纯文档变更跳过 CI

当 PR 或 push 仅修改 `docs/`、`*.md` 等文档文件时，跳过构建、测试和部署，节省 runner 资源和部署风险。

### 实现方式

在 `deploy.yml` 和 `pr-review.yml` 中加入路径过滤或 docs-scope 检测 job。

#### 方案 A：路径过滤（推荐，最简单）

`deploy.yml` 增加 `paths-ignore`：

```yaml
on:
  push:
    branches: [main]
    paths-ignore:
      - 'docs/**'
      - '*.md'
      - '.github/workflows/pr-review.yml'
      - '.github/workflows/claude-comment.yml'
```

`pr-review.yml` 同理：

```yaml
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]
    paths-ignore:
      - 'docs/**'
      - '*.md'
```

**优点：** 零代码，GitHub 原生支持，一行搞定。
**缺点：** 无法处理混合变更（文档 + 代码同时改），混合变更会正常触发 CI（这通常是期望行为）。

#### 方案 B：docs-scope 检测 job（更精细）

适用于未来需要"文档改了也跑 docs lint 但不跑部署"的场景：

```yaml
jobs:
  docs-scope:
    runs-on: ubuntu-latest
    outputs:
      docs_only: ${{ steps.check.outputs.docs_only }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: check
        run: |
          if [ "${{ github.event_name }}" = "push" ]; then
            BASE="${{ github.event.before }}"
          else
            BASE="origin/${{ github.base_ref }}"
          fi
          FILES=$(git diff --name-only "$BASE" HEAD 2>/dev/null || echo "UNKNOWN")
          if [ "$FILES" = "UNKNOWN" ]; then
            echo "docs_only=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          NON_DOCS=$(echo "$FILES" | grep -cvE '^docs/|\.md$' || true)
          if [ "$NON_DOCS" -eq 0 ]; then
            echo "docs_only=true" >> "$GITHUB_OUTPUT"
          else
            echo "docs_only=false" >> "$GITHUB_OUTPUT"
          fi

  deploy:
    needs: docs-scope
    if: needs.docs-scope.outputs.docs_only != 'true'
    # ... 原有 deploy 步骤
```

---

## 2. CI 测试门禁

当前 push 到 main 后直接部署，不运行测试。加入 test + typecheck 作为部署前的必通过门禁。

### 方案 A：在 deploy.yml 中增加 test job（推荐）

```yaml
jobs:
  docs-scope:
    # ... 同上

  test:
    needs: docs-scope
    if: needs.docs-scope.outputs.docs_only != 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci

      - name: Type check
        run: npm run typecheck

      - name: Run tests
        run: npm test

  deploy:
    needs: [docs-scope, test]
    if: needs.docs-scope.outputs.docs_only != 'true'
    runs-on: self-hosted
    concurrency:
      group: deploy-production
      cancel-in-progress: true
    steps:
      # ... 原有部署步骤不变
```

**关键点：**
- `test` job 运行在 `ubuntu-latest`（GitHub-hosted），不占用生产服务器资源
- `deploy` job 依赖 `test` 成功后才执行
- 测试失败 → 部署不执行 → 生产环境不受影响

### 方案 B：额外增加 PR 级别的测试 check

在 PR 阶段就拦截问题，而不是等到 merge 后：

```yaml
# .github/workflows/ci.yml（新文件）
name: CI

on:
  pull_request:
    paths-ignore:
      - 'docs/**'
      - '*.md'

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci

      - name: Type check
        run: npm run typecheck

      - name: Lint
        run: npm run lint

      - name: Run tests
        run: npm test
```

然后在 GitHub repo settings → Branch protection rules → `main` 分支设置 "Require status checks to pass" 勾选 `test` job，这样 PR 必须绿灯才能 merge。

### 推荐组合

两个方案叠加使用效果最佳：

```
PR 阶段:
  ci.yml (test + typecheck + lint)  ← 拦截问题
  pr-review.yml (Claude review)    ← AI 审查

Merge 到 main:
  deploy.yml:
    docs-scope → test → deploy     ← 双重保险
```

---

## 完整的改进后 deploy.yml 参考

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  docs-scope:
    runs-on: ubuntu-latest
    outputs:
      docs_only: ${{ steps.check.outputs.docs_only }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: check
        run: |
          BASE="${{ github.event.before }}"
          FILES=$(git diff --name-only "$BASE" HEAD 2>/dev/null || echo "UNKNOWN")
          if [ "$FILES" = "UNKNOWN" ]; then
            echo "docs_only=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          NON_DOCS=$(echo "$FILES" | grep -cvE '^docs/|\.md$' || true)
          if [ "$NON_DOCS" -eq 0 ]; then
            echo "docs_only=true" >> "$GITHUB_OUTPUT"
          else
            echo "docs_only=false" >> "$GITHUB_OUTPUT"
          fi

  test:
    needs: docs-scope
    if: needs.docs-scope.outputs.docs_only != 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci

      - name: Type check
        run: npm run typecheck

      - name: Run tests
        run: npm test

  deploy:
    needs: [docs-scope, test]
    if: needs.docs-scope.outputs.docs_only != 'true'
    runs-on: self-hosted
    concurrency:
      group: deploy-production
      cancel-in-progress: true
    steps:
      - name: Pull latest code
        run: |
          cd /root/dev/anywhere-code
          git fetch origin main
          git reset --hard origin/main

      - name: Install dependencies
        run: |
          export NVM_DIR="$HOME/.nvm"
          . "$NVM_DIR/nvm.sh"
          cd /root/dev/anywhere-code
          npm ci

      - name: Build
        run: |
          export NVM_DIR="$HOME/.nvm"
          . "$NVM_DIR/nvm.sh"
          cd /root/dev/anywhere-code
          npm run build

      - name: Wait for running queries to finish (direct push only)
        if: ${{ github.event.head_commit.committer.username != 'web-flow' }}
        run: |
          echo "Direct push to main detected, waiting 60s for running queries to finish..."
          sleep 60

      - name: Restart service
        run: |
          export NVM_DIR="$HOME/.nvm"
          . "$NVM_DIR/nvm.sh"
          pm2 restart feishu-claude || pm2 start /root/dev/anywhere-code/ecosystem.config.cjs
```

---

## 改进优先级

| 优先级 | 改进项 | 复杂度 | 收益 |
|--------|--------|--------|------|
| P0 | deploy.yml 加 `paths-ignore` | 3 行 | 避免文档改动触发不必要的部署重启 |
| P1 | deploy.yml 加 test job 门禁 | 中 | 防止坏代码部署到生产 |
| P2 | 新建 ci.yml PR 级别测试 | 中 | 在 PR 阶段拦截问题 |
| P3 | Branch protection 设置 | 配置 | 强制 PR 测试通过才能 merge |
