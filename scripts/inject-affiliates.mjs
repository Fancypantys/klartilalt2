// scripts/inject-affiliates.mjs
// Replaces tokens in Markdown with affiliate URLs / buttons / product cards.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
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

const AIRTABLE_AFF_TABLE_ID = clean(process.env.AIRTABLE_AFF_TABLE_ID) || "";
if (!AIRTABLE_AFF_TABLE_ID)
  throw new Error("Missing AIRTABLE_AFF_TABLE_ID in env");

const AIRTABLE_AFF_VIEW_ID = clean(process.env.AIRTABLE_AFF_VIEW_ID) || "";

// Optional products table (for card image/name)
const AIRTABLE_PROD_TABLE_ID = clean(process.env.AIRTABLE_PROD_TABLE_ID) || "";
const AIRTABLE_PROD_VIEW_ID = clean(process.env.AIRTABLE_PROD_VIEW_ID) || "";

const AFF_TIMEZONE = clean(process.env.AFF_TIMEZONE) || "Europe/Copenhagen";
const AFF_LOCALE = clean(process.env.AFF_LOCALE) || "da-DK";
const AFF_DATA_DIR = clean(process.env.AFF_DATA_DIR) || "src/data";

const AFF_DEFAULT_SOURCE = clean(process.env.AFF_DEFAULT_SOURCE) || "klartilalt";
const AFF_DEFAULT_MEDIUM = clean(process.env.AFF_DEFAULT_MEDIUM) || "affiliate";

// Product field mapping (if products table used)
const PROD_FIELD_SKU = clean(process.env.PROD_FIELD_SKU) || "Product SKU";
const PROD_FIELD_NAME = clean(process.env.PROD_FIELD_NAME) || "Name";
const PROD_FIELD_IMAGE = clean(process.env.PROD_FIELD_IMAGE) || "Image";

// Debug
const DEBUG = String(process.env.AFF_DEBUG || "").toLowerCase() === "true";
if (DEBUG) console.log("[inject] token length:", AIRTABLE_TOKEN.length);

/* -------------------- Fetch helper -------------------- */
async function airtableList({ tableId, viewId }) {
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

/* -------------------- Build maps -------------------- */
const norm = (s) => String(s ?? "").trim();
const normSKU = (s) => norm(s).toUpperCase().replace(/\s+/g, "_");

function urlFromRow(row, { postSlug, dateStr }) {
  const base = norm(row["URL Base"]);
  const full = norm(row["Full Affiliate URL"]);
  const source = norm(row["UTM Source"]) || AFF_DEFAULT_SOURCE;
  const medium = norm(row["UTM Medium"]) || AFF_DEFAULT_MEDIUM;
  const subidTpl = norm(row["Subid Template"]); // may contain {{postSlug}} {{date}}

  const renderedSubId = subidTpl
    ? subidTpl
        .replaceAll("{{postSlug}}", postSlug)
        .replaceAll("{{date}}", dateStr)
    : "";

  if (full) {
    return full
      .replaceAll("{{postSlug}}", postSlug)
      .replaceAll("{{date}}", dateStr);
  }

  if (!base) return "";

  const sep = base.includes("?") ? "&" : "?";
  const params = new URLSearchParams();
  if (source) params.set("utm_source", source);
  if (medium) params.set("utm_medium", medium);
  if (renderedSubId) params.set("subid", renderedSubId);

  return `${base}${sep}${params.toString()}`;
}

function pickAffiliateRow(rows, sku, optCountry) {
  const sameSku = rows.filter((r) => normSKU(r["Product SKU"]) === sku);
  if (!sameSku.length) return null;
  if (!optCountry) return sameSku[0];
  const exact = sameSku.find(
    (r) => norm(r["Country"]).toUpperCase() === optCountry.toUpperCase()
  );
  return exact || sameSku[0];
}

function parseOpts(pipeChunk = "") {
  const out = {};
  for (const p of pipeChunk
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const i = p.indexOf("=");
    if (i === -1) continue;
    out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return out;
}

/* -------------------- Main -------------------- */
const DATA_DIR = path.join(AFF_DATA_DIR, "blog");
const MANIFEST_OUT = "tmp/affiliate-injection-manifest.json";

const RE_SQUARE = /\[AffiliateLink_([A-Za-z0-9_\-]+)\]/g;
const RE_CURLY = /\{\{\s*aff\s*:\s*([A-Za-z0-9_\-]+)\s*(\|[^}]+)?\s*\}\}/g;

async function run() {
  // Build product map (optional)
  const productMap = new Map();
  if (AIRTABLE_PROD_TABLE_ID) {
    const prodRows = await airtableList({
      tableId: AIRTABLE_PROD_TABLE_ID,
      viewId: AIRTABLE_PROD_VIEW_ID || undefined,
    });
    for (const r of prodRows) {
      const sku = normSKU(r[PROD_FIELD_SKU]);
      if (!sku) continue;
      productMap.set(sku, {
        name: norm(r[PROD_FIELD_NAME]),
        image: norm(r[PROD_FIELD_IMAGE]),
      });
    }
    if (DEBUG)
      console.log(
        "Products in map:",
        productMap.size,
        "Sample keys:",
        Array.from(productMap.keys()).slice(0, 5)
      );
  }

  // Fetch affiliate rows
  const affRows = await airtableList({
    tableId: AIRTABLE_AFF_TABLE_ID,
    viewId: AIRTABLE_AFF_VIEW_ID || undefined,
  });
  if (DEBUG) {
    console.log(
      "Detected SKUs:",
      affRows.map((r) => normSKU(r["Product SKU"]))
    );
  }

  const manifest = { files: [], replaced: [], missing: [] };

  const files = await glob(`${DATA_DIR}/**/*.{md,mdx,markdown}`, {
    nodir: true,
  });

  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const fm = matter(raw);
    let body = fm.content;

    const slug =
      norm(fm.data.slug) ||
      norm(path.basename(file).replace(/\.(md|mdx|markdown)$/i, ""));
    const date = fm.data.pubDatetime
      ? new Date(fm.data.pubDatetime)
      : new Date();
    const dateStr = date.toISOString().slice(0, 10);

    let changed = false;

    // [AffiliateLink_SKU]
    body = body.replaceAll(RE_SQUARE, (_m, rawSku) => {
      const sku = normSKU(rawSku);
      const row = pickAffiliateRow(affRows, sku, null);
      if (!row) {
        manifest.missing.push({
          token: `[AffiliateLink_${rawSku}]`,
          reason: "SKU not found",
          file,
        });
        return `[AffiliateLink_${rawSku}]`;
      }
      const url = urlFromRow(row, { postSlug: slug, dateStr });
      manifest.replaced.push({
        token: `[AffiliateLink_${rawSku}]`,
        url,
        file,
      });
      changed = true;
      return url;
    });

    // {{aff:SKU|...}}
    body = body.replaceAll(RE_CURLY, (_m, rawSku, pipe = "") => {
      const sku = normSKU(rawSku);
      const opts = parseOpts(pipe);
      const row = pickAffiliateRow(affRows, sku, opts.country || null);
      if (!row) {
        manifest.missing.push({
          token: `{{aff:${rawSku}${pipe}}}`,
          reason: "SKU not found",
          file,
        });
        return `{{aff:${rawSku}${pipe}}}`;
      }
      const url = urlFromRow(row, { postSlug: slug, dateStr });
      const as = (opts.as || "").toLowerCase();

      if (as === "link") {
        const text = opts.text || "Get it here";
        manifest.replaced.push({
          token: `{{aff:${rawSku}${pipe}}}`,
          url,
          rendered: "markdown-link",
          file,
        });
        changed = true;
        return `[${text}](${url})`;
      }

      if (as === "button") {
        const text = opts.text || "Se pris";
        const btn = `<a class="aff-btn" href="${url}" rel="sponsored nofollow noopener" target="_blank">${text}</a>`;
        manifest.replaced.push({
          token: `{{aff:${rawSku}${pipe}}}`,
          url,
          rendered: "button",
          file,
        });
        changed = true;
        return btn;
      }

      if (as === "card") {
        const text = opts.text || "Se pris";
        const prod = productMap.get(sku) || { name: sku, image: "" };
        const img =
          prod.image &&
          `<img src="${prod.image}" alt="${prod.name || sku}" class="aff-card__img" />`;
        const html = [
          `<div class="aff-card">`,
          img || "",
          `<div class="aff-card__meta">`,
          `<div class="aff-card__title">${prod.name || sku}</div>`,
          `<a class="aff-btn" href="${url}" rel="sponsored nofollow noopener" target="_blank">${text}</a>`,
          `</div>`,
          `</div>`,
        ]
          .filter(Boolean)
          .join("");
        manifest.replaced.push({
          token: `{{aff:${rawSku}${pipe}}}`,
          url,
          rendered: "card",
          file,
        });
        changed = true;
        return html;
      }

      // default → raw URL
      manifest.replaced.push({
        token: `{{aff:${rawSku}${pipe}}}`,
        url,
        rendered: "url",
        file,
      });
      changed = true;
      return url;
    });

    if (changed) {
      const out = matter.stringify(body, fm.data);
      await writeFile(file, out, "utf8");
      manifest.files.push({ file, changed: true });
    } else {
      manifest.files.push({ file, changed: false });
    }
  }

  // 🔧 THIS WAS THE CRASH: we must import & call mkdir from fs/promises
  await mkdir(path.dirname(MANIFEST_OUT), { recursive: true });
  await writeFile(MANIFEST_OUT, JSON.stringify(manifest, null, 2), "utf8");

  const changedCount = manifest.files.filter((f) => f.changed).length;
  console.log(
    `Affiliate injection finished. Updated ${changedCount}/${files.length} files.`
  );
  if (manifest.missing.length) console.warn("Missing:", manifest.missing);
}

run().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
