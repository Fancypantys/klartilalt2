// scripts/sync-content.mjs
// Airtable "Posts" -> Markdown files under src/data/blog/**

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import kebabCase from "lodash.kebabcase";
import matter from "gray-matter";
import "dotenv/config";

/* -------------------- ENV + helpers -------------------- */
const clean = (s) => String(s ?? "").replace(/\r|\n/g, "").trim();
const need = (name) => {
  const v = clean(process.env[name]);
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
};

const AIRTABLE_TOKEN = need("AIRTABLE_TOKEN");
const AIRTABLE_BASE_ID = need("AIRTABLE_BASE_ID");

const AIRTABLE_POSTS_TABLE_ID = clean(process.env.AIRTABLE_POSTS_TABLE_ID);
const AIRTABLE_POSTS_VIEW_ID = clean(process.env.AIRTABLE_POSTS_VIEW_ID);

const AFF_TIMEZONE = clean(process.env.AFF_TIMEZONE) || "Europe/Copenhagen";
const AFF_LOCALE = clean(process.env.AFF_LOCALE) || "da-DK";
const AFF_DATA_DIR = clean(process.env.AFF_DATA_DIR) || "src/data";

const POSTS_FIELD_TITLE = clean(process.env.POSTS_FIELD_TITLE) || "Title";
const POSTS_FIELD_SLUG = clean(process.env.POSTS_FIELD_SLUG) || "Slug";
const POSTS_FIELD_BODY_MD = clean(process.env.POSTS_FIELD_BODY_MD) || "body";
const POSTS_FIELD_TYPE = clean(process.env.POSTS_FIELD_TYPE) || "Category";
const POSTS_FIELD_TAGS = clean(process.env.POSTS_FIELD_TAGS) || "Tags";
const POSTS_FIELD_PUBLISH_AT =
  clean(process.env.POSTS_FIELD_PUBLISH_AT) || "Publication Date";
const POSTS_FIELD_PUBLISH_BOOL =
  clean(process.env.POSTS_FIELD_PUBLISH_BOOL) || "Publish"; // checkbox
const POSTS_FIELD_EXCERPT =
  clean(process.env.POSTS_FIELD_EXCERPT) || "Description";
const POSTS_FIELD_LANGUAGE = clean(process.env.POSTS_FIELD_LANGUAGE) || "";
const POSTS_FIELD_COUNTRY = clean(process.env.POSTS_FIELD_COUNTRY) || "";
const POSTS_FIELD_STATUS = clean(process.env.POSTS_FIELD_STATUS) || "";
const POSTS_ALLOWED_STATUSES = clean(process.env.POSTS_ALLOWED_STATUSES) || "";

const POSTS_FIELD_SKUS = clean(process.env.POSTS_FIELD_SKUS) || "Products";
const POSTS_AUTO_INSERT_TOKENS =
  String(process.env.POSTS_AUTO_INSERT_TOKENS ?? "true").toLowerCase() ===
  "true";

const BLOG_ROOT = path.join(AFF_DATA_DIR || "src/data", "blog");
const OUT_MANIFEST = "tmp/content-sync-manifest.json";

const DEBUG = String(process.env.AFF_DEBUG || "").toLowerCase() === "true";
if (DEBUG) console.log("[sync] token length:", AIRTABLE_TOKEN.length);

/* -------------------- Small utils -------------------- */
const norm = (s) => String(s ?? "").trim();
const asArray = (v) =>
  Array.isArray(v)
    ? v
    : !v
    ? []
    : String(v)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

function cleanUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function chooseDirByType(typeRaw) {
  const t = norm(typeRaw).toLowerCase();
  if (t.startsWith("roundup")) return "roundups";
  if (t.startsWith("review")) return "reviews";
  if (t.startsWith("guide")) return "guides";
  return "";
}

async function ensureDir(p) {
  if (!existsSync(p)) await mkdir(p, { recursive: true });
}

function determineSlug(title, slugField) {
  let slug = norm(slugField) || kebabCase(norm(title));
  return slug.replace(/[^a-z0-9\-]/gi, "-").replace(/--+/g, "-").toLowerCase();
}

/* -------------------- Airtable fetch helper -------------------- */
async function airtableList({ tableId, viewId }) {
  if (!tableId) throw new Error("airtableList: tableId is required");

  const base = new URL(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableId}`
  );
  base.searchParams.set("cellFormat", "string");
  base.searchParams.set("timeZone", AFF_TIMEZONE);
  base.searchParams.set("userLocale", AFF_LOCALE);
  if (viewId) base.searchParams.set("view", viewId);

  const rows = [];
  let offset = null;
  do {
    const url = new URL(base);
    if (offset) url.searchParams.set("offset", offset);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Airtable ${res.status} ${res.statusText} while listing ${tableId}: ${body}`
      );
    }
    const json = await res.json();
    for (const r of json.records || []) rows.push({ id: r.id, ...r.fields });
    offset = json.offset;
  } while (offset);

  return rows;
}

/* -------------------- Inclusion rule -------------------- */
function includeByStatusOrPublish(row) {
  // A) Status if present (backwards compatible)
  if (POSTS_FIELD_STATUS) {
    const allowed = asArray(POSTS_ALLOWED_STATUSES.toLowerCase());
    const status = norm(row[POSTS_FIELD_STATUS]).toLowerCase();
    return allowed.length ? allowed.includes(status) : true;
  }
  // B) Publish checkbox + date ≤ now
  const publishOk = POSTS_FIELD_PUBLISH_BOOL
    ? !!row[POSTS_FIELD_PUBLISH_BOOL]
    : true;
  const publishAt = row[POSTS_FIELD_PUBLISH_AT]
    ? new Date(row[POSTS_FIELD_PUBLISH_AT])
    : null;
  const dateOk = publishAt ? publishAt <= new Date() : true;
  return publishOk && dateOk;
}

/* -------------------- Frontmatter + body -------------------- */
function makeFrontmatter(row, extra = {}) {
  const title = norm(row[POSTS_FIELD_TITLE]);
  const slug = determineSlug(title, row[POSTS_FIELD_SLUG]);

  const tagsRaw = row[POSTS_FIELD_TAGS];
  const tags = Array.isArray(tagsRaw) ? tagsRaw : asArray(tagsRaw);

  const publishAt = row[POSTS_FIELD_PUBLISH_AT]
    ? new Date(row[POSTS_FIELD_PUBLISH_AT])
    : null;
  const now = new Date();
  const draft = publishAt ? publishAt > now : false;

  const fm = {
    title,
    description: norm(row[POSTS_FIELD_EXCERPT] || ""),
    pubDatetime: publishAt ? publishAt.toISOString() : now.toISOString(),
    modDatetime: null,
    draft,
    tags,
    slug,
    ...extra,
  };
  return cleanUndefined(fm);
}

function buildBody(row) {
  const baseMd = norm(row[POSTS_FIELD_BODY_MD]);
  const linked = asArray(row[POSTS_FIELD_SKUS]).map((s) =>
    s.toUpperCase().replace(/\s+/g, "_")
  );

  const content =
    baseMd ||
    [
      "> (Auto-genereret udkast — opdater indledning).",
      "",
      "## Hvorfor stole på os?",
      "- Erfaring, test og objektiv vurdering.",
      "",
      "## Vores anbefalinger",
      "",
    ].join("\n");

  if (!POSTS_AUTO_INSERT_TOKENS || !linked.length) return content;

  let tokens = "\n\n<!-- Auto: Affiliate-kort fra Products/SKUs -->\n";
  for (const sku of linked) tokens += `\n{{aff:${sku}|as=card|text=Se pris}}\n`;
  tokens += "\n";
  return content + tokens;
}

/* -------------------- Main -------------------- */
async function run() {
  const rows = await airtableList({
    tableId: AIRTABLE_POSTS_TABLE_ID,
    viewId: AIRTABLE_POSTS_VIEW_ID || undefined,
  });

  const manifest = { wrote: [], skipped: [] };

  for (const row of rows) {
    if (!includeByStatusOrPublish(row)) {
      manifest.skipped.push({ id: row.id, reason: "filter" });
      continue;
    }

    const typeDir = chooseDirByType(row[POSTS_FIELD_TYPE]);
    const outDir = path.join(BLOG_ROOT, typeDir);
    await ensureDir(outDir);

    const fm = makeFrontmatter(row, {
      country: POSTS_FIELD_COUNTRY
        ? norm(row[POSTS_FIELD_COUNTRY]) || undefined
        : undefined,
      lang: POSTS_FIELD_LANGUAGE
        ? norm(row[POSTS_FIELD_LANGUAGE]) || undefined
        : undefined,
    });

    const filePath = path.join(outDir, `${fm.slug}.md`);
    const body = buildBody(row);
    const finalMd = matter.stringify(body, fm);
    await writeFile(filePath, finalMd, "utf8");

    manifest.wrote.push({ file: filePath, slug: fm.slug });
  }

  await ensureDir(path.dirname(OUT_MANIFEST));
  await writeFile(OUT_MANIFEST, JSON.stringify(manifest, null, 2), "utf8");
  console.log(
    `Content sync finished. Wrote ${manifest.wrote.length} file(s), skipped ${manifest.skipped.length}.`
  );
}

run().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
