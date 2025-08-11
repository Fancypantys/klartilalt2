// scripts/ci-prebuild.mjs
import { execSync } from "node:child_process";

const hasAirtable =
  !!process.env.AIRTABLE_TOKEN &&
  !!process.env.AIRTABLE_BASE_ID &&
  !!process.env.AIRTABLE_AFF_TABLE_ID;

if (!hasAirtable) {
  console.log("🔇 Skipping content sync (no Airtable env present).");
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
