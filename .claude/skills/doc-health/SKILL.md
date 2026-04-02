---
name: doc-health
description: "Set up or audit documentation health for any repo. Use 'init' to bootstrap a docs/ structure (plans/, design/, research/) with YAML front matter, agent discovery scripts, and anti-rot mechanisms. Use 'audit' to detect stale design docs, undistilled completed plans, broken internal links, and CLAUDE.md drift. Use when: 'set up docs', 'doc health', 'check documentation', 'audit docs', 'bootstrap documentation', 'prevent doc rot'."
argument-hint: "<init | audit>"
---

# Doc Health: Documentation Setup & Anti-Rot Audit

Set up a three-layer documentation system for any repo, or audit an existing one for staleness.

## Argument Parsing

Parse `$ARGUMENTS`:
- `init` (or empty) → run **Init Workflow**
- `audit` → run **Audit Workflow**
- anything else → show: "Usage: /doc-health init | audit"

---

## Init Workflow

Bootstrap a documentation structure. Idempotent — skips anything that already exists.

### Step 1: Analyze Project

- Identify the main source directory: check `src/`, `lib/`, `app/`, or project root for code directories
- List top-level module directories (e.g., `src/auth/`, `src/api/`, `src/utils/`)
- Check which of these already exist: `docs/`, `docs/plans/`, `docs/design/`, `docs/research/`
- Check if `CLAUDE.md` exists and whether it already has a documentation section
- Check if `scripts/docs-list.mjs` exists
- Note the current date for `last_updated` fields

### Step 2: Create Directory Structure

Create only directories that don't already exist:

```bash
mkdir -p docs/plans docs/design docs/research
```

### Step 3: Create Design Doc Stubs

For each top-level module directory discovered in Step 1, create a stub design doc at `docs/design/<module-name>.md` — **skip** if a design doc with matching `related_paths` already exists.

Use this template:

```markdown
---
summary: "<infer a one-line description from code, README, or directory name>"
related_paths:
  - <source-dir>/<module>/**
last_updated: "<today>"
---

# <Module Name>

> TODO: Describe current architecture and key design decisions when next modifying this module.
```

**How to infer the summary**: Read the module's `index.ts` (or main file) exports, or check README/CLAUDE.md for mentions. If nothing is available, use the directory name as-is.

### Step 4: Create scripts/docs-list.mjs

If `scripts/docs-list.mjs` does not exist, create it with this content:

```javascript
#!/usr/bin/env node

/**
 * Agent document discovery tool.
 * Scans docs/plans/*.md for YAML front matter and outputs
 * a structured listing for agent auto-discovery.
 *
 * Usage: node scripts/docs-list.mjs [--status <status>] [--json]
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const plansDir = resolve(process.cwd(), "docs/plans");
const args = process.argv.slice(2);
const filterStatus = args.includes("--status")
  ? args[args.indexOf("--status") + 1]
  : null;
const jsonOutput = args.includes("--json");

if (!existsSync(plansDir)) {
  console.log("No docs/plans/ directory found.");
  process.exit(0);
}

function parseFrontMatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fm = {};
  const lines = match[1].split("\n");
  let currentKey = null;
  let currentList = null;

  for (const line of lines) {
    const listMatch = line.match(/^\s+-\s+(.+)/);
    if (listMatch && currentKey) {
      if (!currentList) currentList = [];
      currentList.push(listMatch[1].trim());
      fm[currentKey] = currentList;
      continue;
    }

    const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.*)/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      currentList = null;
      let value = kvMatch[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      fm[currentKey] = value;
    }
  }
  return fm;
}

const plans = [];

for (const file of readdirSync(plansDir).sort()) {
  if (!file.endsWith(".md")) continue;

  const filePath = join(plansDir, file);
  const content = readFileSync(filePath, "utf-8");
  const fm = parseFrontMatter(content);

  const entry = {
    path: `docs/plans/${file}`,
    summary: fm?.summary || "(no summary)",
    status: fm?.status || "unknown",
    owner: fm?.owner || "",
    last_updated: fm?.last_updated || "",
    read_when: fm?.read_when || [],
  };

  if (filterStatus && entry.status !== filterStatus) continue;
  plans.push(entry);
}

if (jsonOutput) {
  console.log(JSON.stringify(plans, null, 2));
} else {
  if (plans.length === 0) {
    console.log("No matching plans found.");
    process.exit(0);
  }

  for (const p of plans) {
    const icon =
      p.status === "completed" ? "+" : p.status === "in_progress" ? ">" : "o";
    console.log(`${icon} [${p.status}] ${p.path}`);
    console.log(`  ${p.summary}`);
    if (p.read_when.length > 0) {
      console.log(`  read_when:`);
      for (const rw of p.read_when) {
        console.log(`    - ${rw}`);
      }
    }
    console.log();
  }
}
```

### Step 5: Update CLAUDE.md

If CLAUDE.md does not exist, create it with a minimal project header and the documentation section below. If it exists but has no documentation section, **append** the section. If a documentation section already exists, **skip**.

Detect an existing section by searching for headings containing "Documentation", "Docs", or the Chinese equivalent.

**Documentation section template to add:**

```markdown
## Documentation

Documents are organized by lifecycle:

| Directory | Content | Lifecycle |
|-----------|---------|-----------|
| `docs/plans/` | Active implementation plans | Short-term; distill to design/ then delete when done |
| `docs/design/` | Module architecture & design decisions (describes **current state**) | Long-term; update when code changes |
| `docs/research/` | Investigation & analysis | Read-only reference |

### Agent Workflow

- **Before starting a task**, scan `docs/plans/*.md` YAML front matter (`summary`, `read_when` fields) to find relevant plans. Read them before coding. Run `node scripts/docs-list.mjs` for a quick listing.
- **When modifying code**, check `docs/design/*.md` `related_paths` fields. If your changes touch a design doc's related paths, read the doc and update it if the description no longer matches the code.
- **When a plan is completed**, distill key design decisions and architecture info into the corresponding `docs/design/` doc, then delete the plan file.

### Front Matter Formats

**Plan files** (`docs/plans/`):
\```yaml
---
summary: "one-line description"
status: draft              # draft | in_progress | completed
owner: git-id
last_updated: "YYYY-MM-DD"
read_when:
  - trigger scenario
---
\```

**Design files** (`docs/design/`):
\```yaml
---
summary: "one-line description"
related_paths:
  - src/module/**
last_updated: "YYYY-MM-DD"
---
\```
```

**Important**: Remove the backslash escapes (`\```) when writing — they are shown here only to avoid breaking this SKILL.md's own formatting.

### Step 6: Summary

Output a checklist of what was created vs skipped:

```
Doc Health Init Complete:
  [created] docs/plans/
  [created] docs/design/
  [created] docs/research/
  [created] docs/design/auth.md (stub)
  [created] docs/design/api.md (stub)
  [skipped] docs/design/utils.md (already exists)
  [created] scripts/docs-list.mjs
  [updated] CLAUDE.md (appended Documentation section)

Next steps:
  - Fill in design doc stubs when working on each module
  - Create plan files in docs/plans/ for new features
  - Run /doc-health audit periodically to check for staleness
```

---

## Audit Workflow

Read-only health check. Reports findings but does not modify any files.

### Check 1: Stale Design Docs

For each `docs/design/*.md` that has a `related_paths` field:

1. Read `last_updated` from front matter
2. For each path in `related_paths`, run: `git log --oneline --since="<last_updated>" -- <path>`
3. If there are commits after `last_updated`, the doc is potentially stale

**Report format:**
```
Stale Design Docs:
  docs/design/pipeline.md — last_updated: 2026-02-23, 5 commits to src/pipeline/** since then
  docs/design/auth.md — last_updated: 2026-01-15, 12 commits to src/auth/** since then
```

### Check 2: Undistilled Completed Plans

Find files in `docs/plans/` where front matter has `status: completed`.

These should have been distilled to `docs/design/` and deleted.

### Check 3: Stale In-Progress Plans

Find files in `docs/plans/` where:
- `status: in_progress`
- `last_updated` is more than 30 days ago

Flag as potentially abandoned.

### Check 4: Broken Internal Links

Scan all `.md` files in `docs/` for:
- Relative file links like `[text](../path/file.md)` or `[text](./other.md)` — verify the target file exists
- Code path references in backticks like `` `src/module/file.ts` `` — verify the file exists using Glob
- Skip external URLs (http/https), anchors (#), and mailto links

### Check 5: CLAUDE.md Module Drift

If CLAUDE.md exists and lists module descriptions (look for file paths like `src/*/`):
- Check that every listed path still exists on disk
- Check that major source directories have at least a mention in CLAUDE.md
- Report unlisted modules and phantom references

### Report

Aggregate all findings into a structured report:

```
## Doc Health Report — <repo name>

### Stale Design Docs (N found)
- docs/design/X.md — last_updated: DATE, M commits since then

### Undistilled Completed Plans (N found)
- docs/plans/plan-X.md — status: completed, should distill to design/ and delete

### Stale In-Progress Plans (N found)
- docs/plans/plan-Y.md — in_progress since DATE (N days ago)

### Broken Internal Links (N found)
- docs/design/X.md:15 — references `src/old/file.ts` which does not exist

### CLAUDE.md Drift (N found)
- CLAUDE.md mentions `src/routing/` but directory does not exist
- `src/cron/` exists but is not mentioned in CLAUDE.md

### Summary
- N stale design docs
- N undistilled plans
- N stale plans
- N broken links
- N CLAUDE.md drift issues
```

If everything is clean, output: "Doc health: all clear."

---

## Notes

- **Generic**: This skill works on any repo. Do not assume a specific project structure — discover it in Step 1.
- **Idempotent init**: Never overwrite existing files. Skip and report.
- **Read-only audit**: Audit reports findings but never modifies files.
- **Front matter parsing**: Be lenient with missing fields — report them as warnings rather than errors.
- **Source directory detection**: Check `src/`, `lib/`, `app/`, `packages/` in order. If none exist, use the project root's immediate subdirectories (excluding `node_modules`, `.git`, `docs`, `dist`, `build`, `test`, `tests`).
