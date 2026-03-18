---
name: setup-claude
description: Install Claude Code skills (ship, pr-fixup, deep-review) and GitHub Actions (pr-review, claude-comment) into the current repo
---

# Setup Claude: One-Click Claude Code Setup

Install a complete Claude Code workflow into the current repository — skills for shipping, PR fixup, and deep review, plus GitHub Actions for automated PR review and @claude comment responses.

## Instructions

You will create **5 files** in the current repository. For each file:

1. Check if the file already exists — if it does, **skip it** and note "already exists"
2. Create parent directories as needed (`.claude/skills/`, `.github/workflows/`)
3. Write the file with the exact content from the templates below

After creating all files, output a summary checklist and remind the user to set `ANTHROPIC_API_KEY` as a GitHub secret.

## File Templates

### File 1: `.claude/skills/ship/SKILL.md`

```markdown
---
name: ship
description: Commit all changes, push to origin, and create a GitHub pull request
disable-model-invocation: true
argument-hint: "[commit message or description of changes]"
---

# Ship: Commit → Push → Create PR

Commit current work, push to origin, and open a pull request — all in one step.

## Steps

### 1. Analyze Changes

- Run `git status` and `git diff` to see all changes
- Run `git log --oneline -5` to learn the project's commit message style
- Identify which files belong to this change (exclude unrelated modifications)

### 2. Commit

- Only `git add` files related to the current change — **never** `git add .` or `git add -A`
- Write a commit message that follows the project's existing style (inferred from `git log`)
- If the user provided a description via `$ARGUMENTS`, use it as the basis for the commit message
- If no description was provided, generate one from the diff content

### 3. Push

- If currently on `main` (or the default branch), create a new branch first (name it based on the changes, e.g. `feat/add-caching`)
- `git push -u origin <branch>`

### 4. Create PR

- Use `gh pr create` to open a pull request
- PR title should match the commit message (without Co-Authored-By)
- PR body format:

## Summary
- <key changes, 1-3 bullet points>

## Test plan
- [ ] <test items>

Generated with [Claude Code](https://claude.com/claude-code)

## Important

- **Never** commit `.env`, credentials, or other sensitive files
- If there are no changes, inform the user instead of creating an empty commit
- Show results at each step; if something fails, stop and explain
- After PR creation, remind the user: run `/pr-fixup` to automatically wait for review and fix issues
```

### File 2: `.claude/skills/pr-fixup/SKILL.md`

```markdown
---
name: pr-fixup
description: Wait for ALL CI checks and PR review to complete, fix CI failures and review issues, loop until PR is clean
argument-hint: "[PR number, default: current branch's PR]"
---

# PR Fixup: CI + Review → Fix → Re-run Loop

Wait for all CI checks and PR review to complete, fix CI build/test failures and review comment issues, and loop until PR is fully clean.

## Gather Context

1. **Get repo info**: `gh repo view --json nameWithOwner -q .nameWithOwner` → get `OWNER/REPO`, then split into OWNER and REPO
2. **Determine PR number**:
   - If `$ARGUMENTS` provides a PR number or URL (`https://github.com/.../pull/N`), extract the number
   - Otherwise: `gh pr view --json number -q .number` to auto-detect the current branch's PR
   - If no PR exists, inform the user and stop
3. **Get current branch**: `git branch --show-current`
4. **Read PR info**: `gh pr view PR_NUMBER` to understand the PR intent

## Main Loop

Repeat the following steps until all CI checks pass and review issues are resolved. **Maximum 5 rounds** — after that, remind the user to intervene manually.

---

### Step 0: Check for Merge Conflicts

Before each round, check if the PR has merge conflicts:

```bash
gh pr view PR_NUMBER --json mergeable,mergeStateStatus -q '{mergeable: .mergeable, state: .mergeStateStatus}'
```

| mergeable | Action |
|-----------|--------|
| `MERGEABLE` | No conflicts, continue to Step 1 |
| `CONFLICTING` | Attempt auto-rebase |
| `UNKNOWN` | GitHub still computing, wait 10s and re-check (max 3 times) |

**Auto-rebase flow:**

1. Get base branch: `gh pr view PR_NUMBER --json baseRefName -q .baseRefName`
2. Rebase:
```bash
git fetch origin BASE_BRANCH
git rebase origin/BASE_BRANCH
```
3. If rebase **succeeds** (no conflicts):
   - `git push --force-with-lease`
   - Output "Rebased to resolve conflicts, waiting for CI..."
   - Return to Step 1
4. If rebase **fails** (unresolvable conflicts):
   - `git rebase --abort`
   - Output conflicting file list, tell user to resolve manually
   - **Stop the loop** — do not attempt to auto-merge conflicts

### Step 1: Wait for All CI Checks to Complete

Poll PR status checks:

```bash
gh pr checks PR_NUMBER
```

- If any check is `pending`/`in_progress`, wait 60s and retry (max 20 minutes)
- When all checks are done, proceed to Step 2

**Important: avoid bare `sleep` — keep output active during polling:**

```bash
for i in $(seq 1 20); do
  result=$(gh pr checks PR_NUMBER 2>&1)
  if echo "$result" | grep -q "pending"; then
    echo "Attempt $i: still pending, waiting 60s..."
    for j in $(seq 1 6); do sleep 10 && echo "  ...waiting ($((j*10))s)"; done
  else
    echo "$result"
    break
  fi
done
```

### Step 2: Handle CI Failures

Categorize check results:

| Category | Action |
|----------|--------|
| **CI build/test failure** (build, test, lint, typecheck) | Get failed logs → fix code |
| **Review failure** (review, pr-review) | Proceed to Step 3 |
| **All passed** | Proceed to Step 3 |

**For CI failures:**

1. Find failed run: `gh run list -b BRANCH -L 5 --json databaseId,name,conclusion,headSha,workflowName`
2. Get logs: `gh run view RUN_ID --log-failed 2>&1 | tail -100`
3. Analyze and fix the code with minimal changes
4. If it's an **environment/platform issue** (not fixable via code), inform user and stop
5. `git add` modified files (don't commit yet — Step 5 handles that)

### Step 3: Get Unresolved Review Comments

Use GraphQL to get all review threads:

```bash
gh api graphql -f query='{
  repository(owner:"OWNER", name:"REPO") {
    pullRequest(number:PR_NUMBER) {
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          comments(first:10) {
            nodes {
              databaseId
              body
              author { login }
              path
              line
            }
          }
        }
      }
    }
  }
}'
```

Filter criteria:
- `isResolved == false` (unresolved)
- First comment's `author.login` is `claude[bot]`

If no CI failures (Step 2 all passed) and no unresolved `claude[bot]` comments → output "All CI checks passed, no blocking review issues" and end the loop.

### Step 4: Analyze and Handle Review Comments

For each unresolved comment:

1. **Read the full source file**: Use the Read tool on the file at `path`
2. **Understand the comment**: Carefully read the specific issue described in `body`
3. **Judge with context**: Is the comment correct?

| Category | Condition | Examples |
|----------|-----------|----------|
| **Real issue** | Code actually has the defect described | Logic error, security vulnerability, resource leak, type unsafety |
| **False positive** | Code is correct, reviewer's analysis is wrong | Missed context, misunderstood control flow, unaware of framework behavior, overly conservative |

**Judgment principle**:
- When in doubt, **lean toward fixing** rather than disputing
- When disputing, you must have a **clear reason** citing specific code

**For real issues:**
- Fix the code with minimal changes, no unrelated refactoring
- `git add` the modified files

**For false positives:**

1. Reply explaining why:
```bash
gh api repos/OWNER/REPO/pulls/PR_NUMBER/comments/COMMENT_DATABASE_ID/replies \
  -f body="Not an issue — <specific explanation>"
```

2. Resolve the thread:
```bash
gh api graphql -f query='mutation {
  resolveReviewThread(input:{threadId:"THREAD_NODE_ID"}) {
    thread { isResolved }
  }
}'
```

### Step 5: Commit, Push, or Finish

Tally results (CI fixes + review fixes + false positives disputed).

**If there were code fixes:**
- `git commit` — infer message style from `git log --oneline -5`
- `git push`
- Output "Round N: fixed X CI issues + Y review issues, disputed Z false positives, waiting for next round..."
- Return to Step 0

**If only false positives were resolved (no code fixes) and CI all passed:**
- Output "Round N: disputed Y false positives and resolved them, all CI checks passed"
- End the loop

---

## Completion Summary

When the loop ends, output a summary:

```
## PR Fixup Complete

- **Total rounds**: N
- **CI issues fixed**: X
- **Review issues fixed**: Y
- **False positives disputed**: Z
- **PR status**: All checks passed, no blocking issues
```

## Important

- Only handle `claude[bot]` comments, not human reviewer comments
- When disputing, give **specific, well-reasoned explanations** citing code context
- Infer commit message style from the project's git log
- If the same issue recurs (fixed then re-reported), stop after round 3 and let the user intervene
- **Do not use bare `sleep`** — long sleeps cause SDK idle timeout. Keep output active during polling
- If CI failure is an environment/platform issue (not code-fixable), inform user instead of retrying
```

### File 3: `.claude/skills/deep-review/SKILL.md`

```markdown
---
name: deep-review
description: Multi-agent parallel code review (security + logic + architecture) for local changes or a PR
argument-hint: "[PR number, PR URL, or empty for local changes]"
---

# Deep Review: Multi-Dimensional Parallel Code Review

Perform a comprehensive code review using multiple agents in parallel, each covering a different review dimension.

## Determine Review Scope

Decide what to review based on `$ARGUMENTS`:

### No arguments (local changes)

Select review scope by priority:

1. **Uncommitted changes** (staged + unstaged + untracked):
   - Run `git diff HEAD` to see tracked file changes
   - Run `git ls-files --others --exclude-standard` to find untracked new files and include their full content
   - If there are any changes or new files, review them
2. **Most recent commit**: If no uncommitted changes, run `git diff HEAD~1..HEAD` to review the latest commit

**Edge cases**:
- Run `git rev-list --count HEAD 2>/dev/null` to check commit count
- If the command fails (no commits), tell the user "no commits yet, nothing to review"
- If there's only 1 commit and no uncommitted changes, use `git show HEAD` instead of `git diff HEAD~1..HEAD`

Run `git status` to confirm the current state and tell the user what scope is being reviewed.

### With arguments (review a PR)

Arguments can be:
- PR number: `/deep-review 4` → `gh pr diff 4`, `gh pr view 4`
- PR URL: `/deep-review https://github.com/org/repo/pull/4` → extract number, then same as above

Use `gh pr diff` for the full diff, `gh pr view` for PR intent.

**Argument validation**: If `$ARGUMENTS` is neither a valid positive integer nor a URL matching `https://github.com/{owner}/{repo}/pull/{number}`, inform the user and show correct usage: `/deep-review 4` or `/deep-review https://github.com/org/repo/pull/4`.

## Multi-Agent Parallel Review

Use TeamCreate to create a review team with **3 parallel agents**, each focused on one dimension.

Shared context for all agents:
- Content of CLAUDE.md (if it exists — read it first and include it if present)
- Full diff content
- List of changed files

### Agent 1: Security Reviewer (security-reviewer)

Checks:
- Injection risks: command injection, SQL injection, XSS, etc.
- Secret/credential exposure (.env, hardcoded API keys, tokens)
- Insecure permission configurations
- Missing input validation (especially at system boundaries: user input, external APIs)
- Insecure dependency usage

### Agent 2: Logic & Correctness Reviewer (logic-reviewer)

Checks:
- Logic errors, off-by-one, null/undefined access
- Race conditions, unhandled Promise rejections
- Error handling gaps (swallowed exceptions, lost error types)
- Resource leaks (unclosed connections, missing event listener cleanup, timer leaks)
- Boundary conditions and error paths

### Agent 3: Architecture & Quality Reviewer (architecture-reviewer)

Checks:
- If CLAUDE.md exists, verify changes follow the project patterns described there
- Check project conventions: consistent import style, module patterns, code organization
- Language-specific: type safety, idiomatic patterns, proper use of language features
- Clean module boundaries, no circular dependencies
- Naming consistency, code organization
- Over-engineering or missing necessary abstractions

### Output Format for Each Agent

Each agent must label every finding with:

- **Severity**: Critical / Warning / Info
- **Confidence**: 0-100
- **File and line**: `path/to/file:42`
- **Issue description**: Concise explanation
- **Suggested fix**: Concrete code change suggestion

**Confidence rules**:
- 90-100: Certain bug or security issue
- 75-89: Highly confident, likely a real problem
- 50-74: Moderate confidence, worth mentioning
- **Below 50: do not report** (too much noise)

**False positive filters (do NOT report)**:
- Issues that existed before the PR/change
- Style preferences or nitpicks
- Issues that linters/formatters will catch automatically
- Missing comments on self-explanatory code
- Hypothetical future problems
- Code that "could be better" but currently works correctly

## Summarize Review Results

After collecting all agent results, compile a single report:

```
## Code Review Summary

**Review scope**: <describe what was reviewed>
**Overall verdict**: Approved / Issues Found / Changes Requested

### Findings

#### Critical
- [security-reviewer] `path/file:42` — description (confidence: 95)

#### Warning
- [logic-reviewer] `path/file:88` — description (confidence: 80)

#### Info
- [architecture-reviewer] `path/file:15` — description (confidence: 60)

### Highlights
- <things done well in the changes>

### Suggestions
- <improvement recommendations>
```

**Verdict criteria**:
- Any Critical → Changes Requested
- Only Warnings → Issues Found
- Only Info or no issues → Approved

## Important

- Each agent must **read the full source files**, not just diff snippets
- Use `git blame` and `git log` to understand change history and context
- Review must be fact-based, citing specific code lines — no speculation
- Provide actionable fix suggestions for every issue, don't just say "this is bad"
```

### File 4: `.github/workflows/pr-review.yml`

```yaml
name: Claude PR Review

on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]

permissions:
  contents: read
  pull-requests: write
  issues: write
  id-token: write
  actions: read

concurrency:
  group: claude-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    if: ${{ !github.event.pull_request.draft }}
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          track_progress: true
          claude_args: |
            --model opus
            --max-budget-usd 10
            --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh api:*),Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*),Bash(gh pr checks:*),Bash(git log:*),Bash(git blame:*),Bash(git diff:*),Read,Glob,Grep"
          prompt: |
            REPO: ${{ github.repository }}
            PR NUMBER: ${{ github.event.pull_request.number }}

            You are a senior code reviewer. Your goal is to find real, actionable issues — not to generate noise.

            ## Step 1: Handle Previous Review Comments

            IMPORTANT: Before starting your review, check for and resolve your own previous comments.

            1. Run `gh api repos/${{ github.repository }}/pulls/${{ github.event.pull_request.number }}/comments --jq '[.[] | select(.user.login == "claude[bot]")]'` to get all your previous inline review comments.
            2. Run `gh pr diff ${{ github.event.pull_request.number }}` to get the current diff.
            3. For each previous comment you left:
               - Read the CURRENT version of the file at the commented line to check if the issue is fixed.
               - If FIXED: reply to that comment via `gh api repos/${{ github.repository }}/pulls/${{ github.event.pull_request.number }}/comments/{comment_id}/replies -f body="Fixed. {brief description of the fix}"`, then resolve the conversation (see step 5).
               - If STILL EXISTS: reply noting it persists, do NOT create a duplicate inline comment for the same issue.
               - If PARTIALLY FIXED: reply explaining what remains.
            4. Only create NEW inline comments for genuinely new issues not already covered by previous comments.
            5. After replying to ALL fixed comments, resolve their conversation threads:
               a. Get review thread IDs: `gh api graphql -f query='{ repository(owner:"${{ github.repository_owner }}", name:"${{ github.event.repository.name }}") { pullRequest(number:${{ github.event.pull_request.number }}) { reviewThreads(first:100) { nodes { id isResolved comments(first:1) { nodes { databaseId body } } } } } } }'`
               b. Match each fixed comment's databaseId to find the thread node ID.
               c. Resolve each thread: `gh api graphql -f query='mutation { resolveReviewThread(input:{threadId:"THREAD_NODE_ID"}) { thread { isResolved } } }'`

            ## Step 2: Setup

            1. Read CLAUDE.md if it exists to understand the project architecture and conventions.
            2. Run `gh pr view ${{ github.event.pull_request.number }}` to understand the PR intent.

            ## Step 3: Review Process

            For EACH changed file in the diff:
            1. Read the FULL source file (not just the diff) to understand context.
            2. Use `git blame` on suspicious lines to understand the change history.
            3. Trace function calls to verify correctness across module boundaries.

            ## What to Look For
            - **Bugs**: Logic errors, off-by-one, null/undefined access, race conditions, unhandled promise rejections
            - **Security**: Injection risks (command, SQL, XSS), secret exposure, unsafe permissions, missing input validation
            - **Architecture**: Does the change follow patterns in CLAUDE.md (if it exists)? Are conventions consistent?
            - **Language-specific**: Type safety, idiomatic patterns, proper use of language features
            - **Resource leaks**: Unclosed connections, missing event listener cleanup, timer leaks

            ## Confidence Scoring
            For each issue, assign a confidence score (0-100):
            - 90-100: Certain this is a real bug or security issue
            - 75-89: Highly confident, likely a real problem
            - 50-74: Moderate confidence, worth mentioning
            - Below 50: Do NOT report — too likely to be a false positive

            Only report issues with confidence >= 75.

            ## False Positive Filters — Do NOT report:
            - Pre-existing issues not introduced in this PR
            - Style preferences or nitpicks
            - Issues that linters/formatters will catch
            - Missing comments on self-explanatory code
            - Hypothetical future problems
            - Code that "could be improved" but works correctly

            ## Step 4: Output

            - Use `mcp__github_inline_comment__create_inline_comment` to post NEW inline comments only for issues not already covered.
            - Post a summary comment via `gh pr comment` with:
              - One-line verdict: Approved / Issues Found
              - If previous issues were resolved, note: "N previous issues fixed"
              - If issues found: bulleted list with severity (critical / warning) and confidence score
              - Brief overall assessment of the PR quality
```

### File 5: `.github/workflows/claude-comment.yml`

```yaml
name: Claude Comment Response

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

permissions:
  contents: read
  pull-requests: write
  issues: write
  id-token: write
  actions: read

concurrency:
  group: claude-comment-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  respond:
    if: |
      (
        github.event_name == 'issue_comment' &&
        contains(github.event.comment.body, '@claude') &&
        github.event.issue.pull_request
      ) ||
      (
        github.event_name == 'pull_request_review_comment' &&
        contains(github.event.comment.body, '@claude')
      ) ||
      (
        github.event_name == 'pull_request_review' &&
        contains(github.event.review.body, '@claude')
      )
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          trigger_phrase: "@claude"
          track_progress: true
          claude_args: |
            --model opus
            --max-budget-usd 10
            --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh api:*),Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*),Bash(gh pr checks:*),Bash(git log:*),Bash(git blame:*),Bash(git diff:*),Read,Glob,Grep"
          prompt: |
            REPO: ${{ github.repository }}

            You are a helpful AI assistant for this project.
            Read CLAUDE.md if it exists to understand the project architecture and conventions.

            When responding:
            1. Always read the relevant source files to understand full context before answering.
            2. Use `git blame` and `git log` to understand change history when relevant.
            3. Provide concrete code examples when suggesting changes.
            4. Use `mcp__github_inline_comment__create_inline_comment` for code-specific feedback.
            5. Verify issues exist by reading actual code — never speculate.
            6. Explain reasoning behind suggestions.
```

## Summary Output

After processing all files, output a checklist like this:

```
## Bootstrap Complete

- [x] `.claude/skills/ship/SKILL.md` — created
- [x] `.claude/skills/pr-fixup/SKILL.md` — created
- [x] `.claude/skills/deep-review/SKILL.md` — created
- [x] `.github/workflows/pr-review.yml` — created
- [x] `.github/workflows/claude-comment.yml` — created

### Next step

Set `ANTHROPIC_API_KEY` as a GitHub repository secret:
  Settings → Secrets and variables → Actions → New repository secret

Then you can use:
- `/ship` — commit, push, and create a PR
- `/deep-review` — multi-agent code review
- `/pr-fixup` — auto-fix PR review issues
- `@claude` in PR comments — get AI assistance
```

Use `[x]` for created files and `[ ] ... (already exists)` for skipped files.
