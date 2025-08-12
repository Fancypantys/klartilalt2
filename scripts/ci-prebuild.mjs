// scripts/ci-prebuild.mjs
import "dotenv/config";
import { execSync } from "node:child_process";

const isCI = String(process.env.CI || "").toLowerCase() === "true";
const hasAirtable =
  !!process.env.AIRTABLE_TOKEN &&
  !!process.env.AIRTABLE_BASE_ID &&
  !!process.env.AIRTABLE_AFF_TABLE_ID;

if (isCI && !hasAirtable) {
  console.log("🔇 Skipping content sync (no Airtable env present in CI).");
  process.exit(0);
}

try {
  execSync("node scripts/sync-content.mjs", { stdio: "inherit" });
  execSync("node scripts/inject-affiliates.mjs", { stdio: "inherit" });
  execSync("node scripts/verify-affiliates.mjs", { stdio: "inherit" });
  process.exit(0);
} catch (e) {
  console.error(e?.message || e);
  process.exit(1);
}
