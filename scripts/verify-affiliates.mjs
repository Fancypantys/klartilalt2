// scripts/verify-affiliates.mjs
// Fail the build if unresolved affiliate tokens remain in any post.

import { readFile } from "node:fs/promises";
import { glob } from "glob";
import path from "node:path";

const DATA_DIR = process.env.AFF_DATA_DIR || "src/data/blog";

// Match patterns for affiliate tokens
const RE_SQUARE = /\[AffiliateLink_([A-Za-z0-9_\-]+)\]/g;
const RE_CURLY = /\{\{\s*aff\s*:\s*([A-Za-z0-9_\-]+)\s*(\|[^}]+)?\s*\}\}/g;

// Utility: find matches with line numbers
function findWithLines(text, regex) {
  const results = [];
  let m;
  while ((m = regex.exec(text)) !== null) {
    const idx = m.index;
    const before = text.slice(0, idx);
    const line = before.split("\n").length; // 1-based
    results.push({ match: m[0], line });
  }
  return results;
}

const unresolved = [];

// Scan all markdown files in the content directory
const files = await glob(`${DATA_DIR}/**/*.{md,mdx,markdown}`, { nodir: true });
for (const file of files) {
  const raw = await readFile(file, "utf8");

  const sq = findWithLines(raw, new RegExp(RE_SQUARE, "g"));
  const cu = findWithLines(raw, new RegExp(RE_CURLY, "g"));

  if (sq.length || cu.length) {
    unresolved.push({
      file: path.relative(process.cwd(), file),
      items: [...sq, ...cu].map((x) => ({ line: x.line, token: x.match }))
    });
  }
}

// If any unresolved tokens remain, exit with failure
if (unresolved.length) {
  console.error("\n❌ Unresolved affiliate tokens found:\n");
  for (const u of unresolved) {
    console.error(`  ${u.file}`);
    for (const it of u.items) {
      console.error(`    line ${it.line}: ${it.token}`);
    }
    console.error("");
  }
  console.error("Fix the SKUs in Airtable or update the posts, then re-run injection.\n");
  process.exit(1);
}

console.log("✅ No unresolved affiliate tokens found.");
