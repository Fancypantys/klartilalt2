// scripts/copy-pagefind.mjs
import { mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const src = path.resolve("dist/pagefind");
const dst = path.resolve("public/pagefind");

async function run() {
  if (!existsSync(src)) {
    console.warn("No pagefind output at:", src);
    return;
  }
  await mkdir(dst, { recursive: true });
  await cp(src, dst, { recursive: true, force: true });
  console.log("Copied pagefind to", dst);
}

run().catch((e) => { console.error(e); process.exit(1); });
