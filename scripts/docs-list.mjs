#!/usr/bin/env node

/**
 * Agent document discovery tool (Phase 4).
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
    // List item
    const listMatch = line.match(/^\s+-\s+(.+)/);
    if (listMatch && currentKey) {
      if (!currentList) currentList = [];
      currentList.push(listMatch[1].trim());
      fm[currentKey] = currentList;
      continue;
    }

    // Key-value pair
    const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.+)/);
    if (kvMatch) {
      // Save previous list if any
      currentKey = kvMatch[1];
      currentList = null;
      let value = kvMatch[2].trim();
      // Strip quotes
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
    const statusIcon =
      p.status === "completed"
        ? "✓"
        : p.status === "in_progress"
          ? "▶"
          : "○";
    console.log(`${statusIcon} [${p.status}] ${p.path}`);
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
