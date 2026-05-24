#!/usr/bin/env tsx
/**
 * plan-9 backfill: attribute legacy project-scoped memories to repositories.
 *
 * Migration v3 already did the trivial backfill (workspace_dir like
 * "github.com/org/repo.git" → "https://github.com/org/repo").  This
 * script is the second pass for rows v3 couldn't infer automatically:
 *   - workspace_dir is an absolute path (not the canonical identity form)
 *   - workspace_dir is missing entirely
 *
 * It is read-only by default. Pass --apply to actually write.
 *
 * Usage:
 *   npx tsx scripts/backfill-memory-repository.ts                    # dry-run
 *   npx tsx scripts/backfill-memory-repository.ts --apply            # write
 *   MEMORY_DB_PATH=./data/memories.db npx tsx scripts/backfill...    # custom db
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const DB_PATH = resolve(process.env.MEMORY_DB_PATH || './data/memories.db');

if (!existsSync(DB_PATH)) {
  console.error(`Memory database not found at ${DB_PATH}`);
  process.exit(1);
}

const PROJECT_SCOPED = new Set(['fact', 'decision', 'relation']);

/** Convert "github.com/org/repo.git" → "https://github.com/org/repo". */
function identityToCanonicalUrl(identity: string): string | null {
  if (!identity || identity.startsWith('/')) return null;
  if (!identity.endsWith('.git')) return null;
  return 'https://' + identity.slice(0, -4);
}

/**
 * Resolve a free-form workspace_dir to a canonical repo URL when possible.
 *   - "github.com/org/repo.git"        → "https://github.com/org/repo"
 *   - "/root/dev/.workspaces/foo-bar"  → null (path-style; need git remote, skipped here)
 *   - "/root/dev/anywhere-code"        → null (same)
 *   - null / ""                        → null
 */
function inferRepository(workspaceDir: string | null): string | null {
  if (!workspaceDir) return null;
  return identityToCanonicalUrl(workspaceDir);
}

const db = new Database(DB_PATH, { readonly: !APPLY });

interface Row {
  id: string;
  type: string;
  workspace_dir: string | null;
  content: string;
}

const rows = db.prepare(`
  SELECT id, type, workspace_dir, content
  FROM memories
  WHERE repository IS NULL
    AND invalid_at IS NULL
    AND type IN ('fact', 'decision', 'relation')
`).all() as Row[];

let inferred = 0;
let skipped = 0;
const examples: Array<{ id: string; repo: string; preview: string }> = [];
const skippedExamples: Array<{ id: string; ws: string | null; preview: string }> = [];

const update = APPLY
  ? db.prepare(`UPDATE memories SET repository = @repository, updated_at = @updated_at WHERE id = @id`)
  : null;

const now = new Date().toISOString();
const txn = APPLY
  ? db.transaction((items: Array<{ id: string; repository: string }>) => {
      for (const item of items) {
        update!.run({ id: item.id, repository: item.repository, updated_at: now });
      }
    })
  : null;

const toWrite: Array<{ id: string; repository: string }> = [];

for (const row of rows) {
  if (!PROJECT_SCOPED.has(row.type)) continue;
  const repo = inferRepository(row.workspace_dir);
  if (repo) {
    inferred++;
    toWrite.push({ id: row.id, repository: repo });
    if (examples.length < 5) {
      examples.push({ id: row.id, repo, preview: row.content.slice(0, 60) });
    }
  } else {
    skipped++;
    if (skippedExamples.length < 5) {
      skippedExamples.push({ id: row.id, ws: row.workspace_dir, preview: row.content.slice(0, 60) });
    }
  }
}

if (APPLY && toWrite.length > 0) {
  txn!(toWrite);
}

console.log(`\nplan-9 backfill report — ${APPLY ? 'APPLIED' : 'DRY-RUN'}`);
console.log(`  db: ${DB_PATH}`);
console.log(`  scanned (project-scoped, repo=null): ${rows.length}`);
console.log(`  inferred & ${APPLY ? 'updated' : 'would-update'}: ${inferred}`);
console.log(`  skipped (need manual review): ${skipped}`);

if (examples.length > 0) {
  console.log(`\nSample fixes:`);
  for (const ex of examples) {
    console.log(`  ${ex.id}  →  ${ex.repo}`);
    console.log(`    "${ex.preview}${ex.preview.length === 60 ? '…' : ''}"`);
  }
}

if (skippedExamples.length > 0) {
  console.log(`\nSample skipped rows (workspace_dir not in canonical form):`);
  for (const ex of skippedExamples) {
    console.log(`  ${ex.id}  workspace_dir=${ex.ws ?? '∅'}`);
    console.log(`    "${ex.preview}${ex.preview.length === 60 ? '…' : ''}"`);
  }
  console.log(`\n  These rows need manual classification or /memory move (P5).`);
}

if (!APPLY && inferred > 0) {
  console.log(`\nRe-run with --apply to write changes.`);
}

db.close();
