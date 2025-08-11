// scripts/sync-content.mjs
// Airtable "Posts" -> Markdown filer i src/data/blog/**.
// Laver frontmatter, slug, og (valgfrit) auto-indskyder affiliate-kort tokens
// ud fra et SKUs-felt. Kører bedst sammen med inject-affiliates.mjs bagefter.

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import kebabCase from "lodash.kebabcase";
import matter from "gray-matter";
import "dotenv/config";

const {
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,

  // Posts tabel (brug IDs fra Airtable URL)
  AIRTABLE_POSTS_TABLE_ID,
  AIRTABLE_POSTS_VIEW_ID,

  // Påkrævet når cellFormat=string (giver pæne tekstværdier)
  AFF_TIMEZONE = "Europe/Copenhagen",
  AFF_LOCALE = "da-DK",

  // Udskrifts-roden til content
  AFF_DATA_DIR = "src/data",

  // Feltnavne i "Posts" (ret hvis dine kolonner hedder noget andet)
  POSTS_FIELD_STATUS = "Status",
  POSTS_FIELD_TITLE = "Title",
  POSTS_FIELD_SLUG = "Slug",
  POSTS_FIELD_TYPE = "Post Type",            // roundup | review | guide | ...
  POSTS_FIELD_LANGUAGE = "Language",
  POSTS_FIELD_COUNTRY = "Country",
  POSTS_FIELD_TAGS = "Tags",
  POSTS_FIELD_EXCERPT = "Excerpt",
  POSTS_FIELD_BODY_MD = "Markdown",          // alternativt "Content"/"Body"
  POSTS_FIELD_PUBLISH_AT = "Publish At",
  POSTS_FIELD_HERO = "Hero Image",           // URL eller attachment
  POSTS_FIELD_SKUS = "SKUs",                 // fx "SKU123, SKU456" / multiselect

  // Hvilke Status-værdier må blive til filer
  POSTS_ALLOWED_STATUSES = "Ready,Scheduled,Publish",

  // Auto-indskyd affiliate tokens i bunden hvis der er SKUs?
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
  return ""; // ellers læg i blog-roden
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

function makeFrontmatter(row, extra = {}) {
  const title = norm(row[POSTS_FIELD_TITLE]);
  const slug = determineSlug(title, row[POSTS_FIELD_SLUG]);

  const tagsRaw = row[POSTS_FIELD_TAGS];
  const tags = Array.isArray(tagsRaw) ? tagsRaw : asArray(tagsRaw);

  const hero = norm(row[POSTS_FIELD_HERO]); // gemmer ikke nu, men let at bruge senere
  const publishAt = row[POSTS_FIELD_PUBLISH_AT] ? new Date(row[POSTS_FIELD_PUBLISH_AT]) : null;
  const now = new Date();
  const draft = publishAt ? publishAt > now : false;

  return {
    title,
    description: norm(row[POSTS_FIELD_EXCERPT]),
    pubDatetime: publishAt ? publishAt.toISOString() : now.toISOString(),
    modDatetime: null,
    draft,
    tags,
    slug,
    ...extra,
  };
}

async function ensureDir(p) {
  if (!existsSync(p)) {
    await mkdir(p, { recursive: true });
  }
}

function buildBody(row) {
  const baseMd = norm(row[POSTS_FIELD_BODY_MD]);
  const country = norm(row[POSTS_FIELD_COUNTRY]);
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

  let tokens = "\n\n<!-- Auto: Affiliate-kort fra SKUs -->\n";
  for (const sku of skuList) {
    const countryOpt = country ? `|country=${country}` : "";
    tokens += `\n{{aff:${sku}|as=card${countryOpt}|text=Se pris}}\n`;
  }
  tokens += "\n";
  return content + tokens;
}

async function run() {
  const allowed = POSTS_ALLOWED_STATUSES.split(",").map((s) => s.trim().toLowerCase());
  const rows = await fetchAirtablePosts();

  const manifest = { wrote: [], skipped: [] };

  for (const row of rows) {
    const status = norm(row[POSTS_FIELD_STATUS]).toLowerCase();
    if (!allowed.includes(status)) {
      manifest.skipped.push({ id: row.id, status });
      continue;
    }

    const typeDir = chooseDirByType(row[POSTS_FIELD_TYPE]);
    const outDir = path.join(BLOG_ROOT, typeDir);
    await ensureDir(outDir);

    const fm = makeFrontmatter(row, {
      country: norm(row[POSTS_FIELD_COUNTRY]) || undefined,
      lang: norm(row[POSTS_FIELD_LANGUAGE]) || undefined,
    });

    const filePath = path.join(outDir, `${fm.slug}.md`);
    const body = buildBody(row);
    const finalMd = matter.stringify(body, fm);

    await writeFile(filePath, finalMd, "utf8");
    manifest.wrote.push({ file: filePath, slug: fm.slug, status });
  }

  await ensureDir(path.dirname(OUT_MANIFEST));
  await writeFile(OUT_MANIFEST, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`Content sync finished. Wrote ${manifest.wrote.length} file(s), skipped ${manifest.skipped.length}.`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
