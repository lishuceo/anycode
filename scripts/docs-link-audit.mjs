#!/usr/bin/env node

/**
 * Internal link checker for docs/*.md files.
 * Scans all markdown files and verifies that internal links
 * (relative paths and anchor references) point to existing files.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { globSync } from "node:fs";

// Use simple recursive readdir since we don't have glob dependency
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walkDir(dir, ext) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      results.push(...walkDir(fullPath, ext));
    } else if (entry.isFile() && fullPath.endsWith(ext)) {
      results.push(fullPath);
    }
  }
  return results;
}

const docsDir = resolve(process.cwd(), "docs");
const rootDir = process.cwd();

if (!existsSync(docsDir)) {
  console.log("No docs/ directory found, skipping link audit.");
  process.exit(0);
}

const mdFiles = [
  ...walkDir(docsDir, ".md"),
  ...(existsSync(resolve(rootDir, "README.md"))
    ? [resolve(rootDir, "README.md")]
    : []),
];

// Regex to match markdown links: [text](path)
const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;

let brokenCount = 0;
let totalChecked = 0;
let inCodeFence = false;

for (const file of mdFiles) {
  const content = readFileSync(file, "utf-8");
  const lines = content.split("\n");
  inCodeFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track code fences
    if (line.trimStart().startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    // Strip inline code before scanning
    const cleanLine = line.replace(/`[^`]+`/g, "");

    let match;
    linkRegex.lastIndex = 0;
    while ((match = linkRegex.exec(cleanLine)) !== null) {
      const linkTarget = match[2];

      // Skip external links, mailto, anchors, data URIs
      if (
        linkTarget.startsWith("http://") ||
        linkTarget.startsWith("https://") ||
        linkTarget.startsWith("mailto:") ||
        linkTarget.startsWith("tel:") ||
        linkTarget.startsWith("data:") ||
        linkTarget.startsWith("#")
      ) {
        continue;
      }

      totalChecked++;

      // Strip anchor from path
      const pathPart = linkTarget.split("#")[0];
      if (!pathPart) continue; // pure anchor

      // Resolve relative to the file's directory
      const resolved = resolve(dirname(file), pathPart);

      if (!existsSync(resolved)) {
        const relFile = file.replace(rootDir + "/", "");
        console.error(
          `  BROKEN: ${relFile}:${i + 1} → ${linkTarget} (resolved: ${resolved.replace(rootDir + "/", "")})`,
        );
        brokenCount++;
      }
    }
  }
}

console.log(
  `\nLink audit: checked ${totalChecked} internal links across ${mdFiles.length} files.`,
);

if (brokenCount > 0) {
  console.error(`\n✗ Found ${brokenCount} broken link(s).`);
  process.exit(1);
} else {
  console.log("✓ All internal links valid.");
}
