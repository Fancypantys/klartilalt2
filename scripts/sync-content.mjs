// scripts/sync-content.mjs
// Airtable "Posts" -> Markdown i src/data/blog/**.
// Inklusion: enten (A) Status matcher POSTS_ALLOWED_STATUSES, eller
// (B) Publish-checkbox er true OG/ELLER Publication Date er ikke i fremtiden.

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import kebabCase from "lodash.kebabcase";
import matter from "gray-matter";
import "dotenv/config";

const {
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,

  AIRTABLE_POSTS_TABLE_ID,
  AIRTABLE_POSTS_VIEW_ID,

  AFF_TIMEZONE = "Europe/Copenhagen",
  AFF_LOCALE = "da-DK",
  AFF_DATA_DIR = "src/data",

  // Feltmapping (tilpas til din tabel)
  POSTS_FIELD_TITLE = "Title",
  POSTS_FIELD_SLUG = "Slug",
  POSTS_FIELD_BODY_MD = "body",
  POSTS_FIELD_TYPE = "Category",
  POSTS_FIELD_TAGS = "Tags",
  POSTS_FIELD_PUBLISH_AT = "Publication Date",
  POSTS_FIELD_PUBLISH_BOOL = "Publish",   // checkbox
  POSTS_FIELD_SKUS = "Products",          // linket felt; kommer som kommasepareret streng i cellFormat=string
  POSTS_FIELD_HERO = "OG Image",
  POSTS_FIELD_LANGUAGE = "",              // valgfri
  POSTS_FIELD_COUNTRY = "",               // valgfri
  POSTS_FIELD_EXCERPT = "Description",    // valgfri: kort beskrivelse/uddrag

  // Status (ikke brugt hos dig – men understøttes hvis du tilføjer det senere)
  POSTS_FIELD_STATUS = "",
  POSTS_ALLOWED_STATUSES = "",

  // Auto-indskyd tokens nederst ud fra SKUs/Products
  POSTS_AUTO_INSERT_TOKENS = "true"
} = process.env;

if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_POSTS_TABLE_ID) {
  console.error("Missing AIRTABLE_TOKEN, AIRTABLE_BASE_ID or AIRTABLE_POSTS_TABLE_ID in .env");
  process.exit(1);
}

const BLOG_ROOT = path.join(AFF_DATA_DIR, "blog");
const OUT_MANIFEST = "tmp/content-sync-manifest.json";

const norm = (s) => String(s ?? "").trim();
const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
};

function chooseDirByType(typeRaw) {
  const t = norm(typeRaw).toLowerCase();
  if (t.startsWith("roundup")) return "roundups";
  if (t.startsWith("review")) return "reviews";
  if (t.startsWith("guide")) return "guides";
  return ""; // ellers i blog-roden
}

async function fetchAirtablePosts() {
  const rows = [];
  let offset = null;
  const baseUrl = new URL(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_POSTS_TABLE_ID}`
  );
  baseUrl.searchParams.set("cellFormat", "string");
  baseUrl.searchParams.set("timeZone", AFF_TIMEZONE);
  baseUrl.searchParams.set("userLocale", AFF_LOCALE);
  if (AIRTABLE_POSTS_VIEW_ID) baseUrl.searchParams.set("view", AIRTABLE_POSTS_VIEW_ID);

  do {
    const url = new URL(baseUrl);
    if (offset) url.searchParams.set("offset", offset);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
    const json = await res.json();
    rows.push(...json.records.map((r) => ({ id: r.id, ...r.fields })));
    offset = json.offset;
  } while (offset);

  return rows;
}

function determineSlug(title, slugField) {
  let slug = norm(slugField) || kebabCase(norm(title));
  slug = slug.replace(/[^a-z0-9\-]/gi, "-").replace(/--+/g, "-").toLowerCase();
  return slug;
}

function cleanUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function makeFrontmatter(row, extra = {}) {
  const title = norm(row[POSTS_FIELD_TITLE]);
  const slug = determineSlug(title, row[POSTS_FIELD_SLUG]);

  const tagsRaw = row[POSTS_FIELD_TAGS];
  const tags = Array.isArray(tagsRaw) ? tagsRaw : asArray(tagsRaw);

  const publishAt = row[POSTS_FIELD_PUBLISH_AT] ? new Date(row[POSTS_FIELD_PUBLISH_AT]) : null;
  const now = new Date();
  const draft = publishAt ? publishAt > now : false;

  const fm = {
    title,
    description: norm(row[POSTS_FIELD_EXCERPT] || ""), // aldrig undefined
    pubDatetime: publishAt ? publishAt.toISOString() : now.toISOString(),
    modDatetime: null,
    draft,
    tags,
    slug,
    ...extra
  };

  return cleanUndefined(fm);
}

async function ensureDir(p) {
  if (!existsSync(p)) {
    await mkdir(p, { recursive: true });
  }
}

function buildBody(row) {
  const baseMd = norm(row[POSTS_FIELD_BODY_MD]);
  // Products-feltet kommer som streng i cellFormat=string (typisk primær felt på Products-tabellen)
  const skuList = asArray(row[POSTS_FIELD_SKUS]).map((s) => s.toUpperCase().replace(/\s+/g, "_"));

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

  if (String(POSTS_AUTO_INSERT_TOKENS).toLowerCase() !== "true" || !skuList.length) {
    return content;
  }

  let tokens = "\n\n<!-- Auto: Affiliate-kort fra Products/SKUs -->\n";
  for (const raw of skuList) {
    const sku = raw.toUpperCase(); // antager at primær felt på Products = SKU
    tokens += `\n{{aff:${sku}|as=card|text=Se pris}}\n`;
  }
  tokens += "\n";
  return content + tokens;
}

function includeByStatusOrPublish(row) {
  // A) Status-filter hvis sat
  const statusField = norm(POSTS_FIELD_STATUS);
  if (statusField) {
    const allowed = asArray(String(POSTS_ALLOWED_STATUSES).toLowerCase());
    const status = norm(row[statusField]).toLowerCase();
    return allowed.length ? allowed.includes(status) : true;
  }
  // B) Publish-checkbox + dato ≤ nu
  const publishOk = POSTS_FIELD_PUBLISH_BOOL ? !!row[POSTS_FIELD_PUBLISH_BOOL] : true;
  const publishAt = row[POSTS_FIELD_PUBLISH_AT] ? new Date(row[POSTS_FIELD_PUBLISH_AT]) : null;
  const dateOk = publishAt ? publishAt <= new Date() : true;
  return publishOk && dateOk;
}

async function run() {
  const rows = await fetchAirtablePosts();

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
      country: POSTS_FIELD_COUNTRY ? norm(row[POSTS_FIELD_COUNTRY]) || undefined : undefined,
      lang: POSTS_FIELD_LANGUAGE ? norm(row[POSTS_FIELD_LANGUAGE]) || undefined : undefined
    });

    const filePath = path.join(outDir, `${fm.slug}.md`);
    const body = buildBody(row);
    const finalMd = matter.stringify(body, fm); // fm er renset for undefined

    await writeFile(filePath, finalMd, "utf8");
    manifest.wrote.push({ file: filePath, slug: fm.slug });
  }

  await ensureDir(path.dirname(OUT_MANIFEST));
  await writeFile(OUT_MANIFEST, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`Content sync finished. Wrote ${manifest.wrote.length} file(s), skipped ${manifest.skipped.length}.`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
