// scripts/inject-affiliates.mjs
// Inject affiliate URLs from Airtable into Markdown posts.
//
// Tokens supported:
//  • [AffiliateLink_SKU]                                 -> plain URL
//  • {{aff:SKU|as=link|text=...|country=DK}}            -> markdown link
//  • {{aff:SKU|as=button|text=...}}                     -> HTML <a> button
//  • {{aff:SKU|as=card|text=...}}                       -> Product card (image + optional title + CTA)
//
// Robust:
//  • Handles linked-record SKUs via cellFormat=string (requires timeZone/userLocale).
//  • Optional Products table used for card image/title.
//  • Smart field fallbacks + verbose debug when AFF_DEBUG=true.
//  • Cards no longer show the SKU as a fallback title. If no real title, the title row is hidden.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { glob } from "glob";
import matter from "gray-matter";
import "dotenv/config";

const DATA_DIR = process.env.AFF_DATA_DIR || "src/data/blog";
const MANIFEST_OUT = process.env.AFF_MANIFEST_OUT || "tmp/affiliate-injection-manifest.json";
const DEBUG = String(process.env.AFF_DEBUG || "").toLowerCase() === "true";
const DEBUG_SKU = (process.env.AFF_DEBUG_SKU || "").trim();

const {
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,

  // Affiliate Links (primary URL source)
  AIRTABLE_AFF_TABLE_ID,
  AIRTABLE_AFF_VIEW_ID,

  // Products (optional; for card rendering)
  AIRTABLE_PROD_TABLE_ID,
  AIRTABLE_PROD_VIEW_ID,

  // Airtable requires these when using cellFormat=string
  AFF_TIMEZONE = "Europe/Copenhagen",
  AFF_LOCALE = "da-DK",

  // Defaults for UTMs
  AFF_DEFAULT_SOURCE = "klartilalt",
  AFF_DEFAULT_MEDIUM = "affiliate",
  AFF_DEFAULT_CAMPAIGN = "",

  // Button defaults
  AFF_BUTTON_CLASS = "cta cta-orange",
  AFF_BUTTON_TARGET = "_blank",
  AFF_BUTTON_REL = "nofollow sponsored noopener",
  AFF_BUTTON_TEXT = "Claim now",

  // Card defaults
  AFF_CARD_CLASS = "aff-card",
  AFF_CARD_IMG_CLASS = "aff-card-img",
  AFF_CARD_BODY_CLASS = "aff-card-body",
  AFF_CARD_TITLE_CLASS = "aff-card-title",
  AFF_CARD_CTA_CLASS = "cta cta-orange",
  // New: global image width (px). Leave blank to control via CSS only.
  AFF_CARD_IMG_WIDTH = "",

  // Affiliate Links field names
  AFF_FIELD_SKU = "Product SKU",
  AFF_FIELD_URL_BASE = "URL Base",
  AFF_FIELD_UTM_SOURCE = "UTM Source",
  AFF_FIELD_UTM_MEDIUM = "UTM Medium",
  AFF_FIELD_UTM_CAMPAIGN = "UTM Campaign",
  AFF_FIELD_SUBID_TEMPLATE = "Subid Template",
  AFF_FIELD_COUNTRY = "Country",
  AFF_FIELD_FULL_URL = "Full Affiliate URL",

  // Products field names (override in .env if your headers differ)
  // IMPORTANT: PROD_FIELD_SKU must hold values like "SKU54321"
  PROD_FIELD_SKU = "SKU",
  PROD_FIELD_NAME = "Name",
  PROD_FIELD_IMAGE = "Image"
} = process.env;

if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_AFF_TABLE_ID) {
  console.error("Missing AIRTABLE_TOKEN, AIRTABLE_BASE_ID or AIRTABLE_AFF_TABLE_ID in .env");
  process.exit(1);
}

// ---------- Airtable fetchers ----------
async function fetchAirtableString({ tableId, viewId }) {
  // For Affiliate Links (needs string display for linked fields).
  const rows = [];
  let offset = null;
  const baseUrl = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableId}`);
  baseUrl.searchParams.set("cellFormat", "string");
  baseUrl.searchParams.set("timeZone", AFF_TIMEZONE);
  baseUrl.searchParams.set("userLocale", AFF_LOCALE);
  if (viewId) baseUrl.searchParams.set("view", viewId);

  do {
    const url = new URL(baseUrl);
    if (offset) url.searchParams.set("offset", offset);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
    const json = await res.json();
    rows.push(...json.records.map(r => ({ id: r.id, ...r.fields })));
    offset = json.offset;
  } while (offset);
  return rows;
}

async function fetchAirtableRaw({ tableId, viewId }) {
  // For Products (keep attachments intact).
  const rows = [];
  let offset = null;
  const baseUrl = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableId}`);
  if (viewId) baseUrl.searchParams.set("view", viewId);

  do {
    const url = new URL(baseUrl);
    if (offset) url.searchParams.set("offset", offset);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
    const json = await res.json();
    rows.push(...json.records.map(r => ({ id: r.id, ...r.fields })));
    offset = json.offset;
  } while (offset);
  return rows;
}

// ---------- helpers ----------
const norm = s => String(s || "").trim();
const normSKU = s => norm(s).toUpperCase().replace(/\s+/g, "_");

function getField(row, name) {
  // exact key
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  // relaxed match (collapse NBSP/multi-spaces)
  const normKey = x => String(x).replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const want = normKey(name);
  for (const k of Object.keys(row)) if (normKey(k) === want) return row[k];
  return undefined;
}

function firstAttachmentUrl(val) {
  if (!val) return "";
  if (Array.isArray(val) && val.length && val[0]?.url) return String(val[0].url);
  if (typeof val === "string" && /^https?:\/\//i.test(val)) return val;
  return "";
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Try a list of field candidates until one returns a value
function getFirstOf(row, candidates) {
  for (const c of candidates) {
    const v = getField(row, c);
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

// ---------- affiliate URL builder ----------
function buildLink(row, { postSlug, dateStr }, opts = {}) {
  const base = norm(getField(row, AFF_FIELD_URL_BASE));
  const full = norm(getField(row, AFF_FIELD_FULL_URL));

  const resolved = {
    source: norm(opts.source) || norm(getField(row, AFF_FIELD_UTM_SOURCE)) || AFF_DEFAULT_SOURCE,
    medium: norm(opts.medium) || norm(getField(row, AFF_FIELD_UTM_MEDIUM)) || AFF_DEFAULT_MEDIUM,
    campaign: norm(opts.campaign) || norm(getField(row, AFF_FIELD_UTM_CAMPAIGN)) || AFF_DEFAULT_CAMPAIGN,
    country: norm(opts.country) || norm(getField(row, AFF_FIELD_COUNTRY)) || ""
  };

  const subidTpl = norm(getField(row, AFF_FIELD_SUBID_TEMPLATE));
  const renderedSubId = subidTpl
    ? subidTpl.replaceAll("{{postSlug}}", postSlug).replaceAll("{{date}}", dateStr)
    : "";

  if (full) {
    const url = full.replaceAll("{{postSlug}}", postSlug).replaceAll("{{date}}", dateStr);
    return { url, resolved };
  }

  if (!base) return { url: "", resolved };

  const hasQuery = base.includes("?");
  theSep: {
  }
  const sep = base.includes("?") ? "&" : "?";
  const params = new URLSearchParams();
  if (resolved.source) params.set("utm_source", resolved.source);
  if (resolved.medium) params.set("utm_medium", resolved.medium);
  if (resolved.campaign) params.set("utm_campaign", resolved.campaign);
  if (renderedSubId) params.set("subid", renderedSubId);

  const q = params.toString();
  return { url: q ? `${base}${sep}${q}` : base, resolved };
}

function chooseRow(rows, sku, countryOpt) {
  const sameSku = rows.filter(r => {
    const val = getField(r, AFF_FIELD_SKU);
    return val && normSKU(val) === sku;
  });
  if (!sameSku.length) return null;
  if (!countryOpt) return sameSku[0];
  const exact = sameSku.find(r => {
    const c = getField(r, AFF_FIELD_COUNTRY);
    return c && norm(c).toUpperCase() === countryOpt.toUpperCase();
  });
  return exact || sameSku[0];
}

// ---------- token parsing ----------
const RE_SQUARE = /\[AffiliateLink_([A-Za-z0-9_\-]+)\]/g;
const RE_CURLY  = /\{\{\s*aff\s*:\s*([A-Za-z0-9_\-]+)\s*(\|[^}]+)?\s*\}\}/g;

function parseOpts(pipeChunk = "") {
  const out = {};
  for (const p of pipeChunk.split("|").map(s => s.trim()).filter(Boolean)) {
    const i = p.indexOf("=");
    if (i === -1) continue;
    out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return out;
}

async function run() {
  // --- Affiliate Links (string values so linked SKU becomes text) ---
  const affRows = await fetchAirtableString({
    tableId: AIRTABLE_AFF_TABLE_ID,
    viewId: AIRTABLE_AFF_VIEW_ID || undefined
  });

  // --- Products (attachments intact) ---
  let productMap = new Map();
  if (AIRTABLE_PROD_TABLE_ID) {
    const prodRows = await fetchAirtableRaw({
      tableId: AIRTABLE_PROD_TABLE_ID,
      viewId: AIRTABLE_PROD_VIEW_ID || undefined
    });

    // Smarter field fallbacks
    const skuCandidates   = [PROD_FIELD_SKU, "SKU", "Product SKU", "Sku", "Code", "Product Code", "ID"];
    const nameCandidates  = [PROD_FIELD_NAME, "Name", "Title", "Product Name"];
    const imageCandidates = [PROD_FIELD_IMAGE, "Image", "Images", "Photo", "Photos", "Picture", "Main Image"];

    for (const r of prodRows) {
      const skuValRaw = getFirstOf(r, skuCandidates);
      if (!skuValRaw) continue;
      const skuKey = normSKU(skuValRaw);

      const nameVal = norm(getFirstOf(r, nameCandidates)); // may be ""
      const imgVal = getFirstOf(r, imageCandidates);
      const imgUrl = firstAttachmentUrl(imgVal);

      productMap.set(skuKey, { name: nameVal, image: imgUrl });
    }

    if (DEBUG) {
      const firstProd = prodRows[0] || {};
      console.log("Products in map:", productMap.size);
      console.log("First product row keys:", Object.keys(firstProd));
      const firstKeys = Array.from(productMap.keys()).slice(0, 10);
      console.log("ProductMap keys (first 10):", firstKeys);
      if (DEBUG_SKU) {
        console.log(`Lookup product "${DEBUG_SKU}":`, productMap.get(normSKU(DEBUG_SKU)));
      }
    }
  }

  if (DEBUG) {
    console.log("Fetched affiliate rows:", affRows.length);
    console.log("Detected SKUs:", affRows.map(r => getField(r, AFF_FIELD_SKU)));
  }

  // Ensure manifest dir
  const manifestDir = path.dirname(MANIFEST_OUT);
  if (!existsSync(manifestDir)) mkdirSync(manifestDir, { recursive: true });
  const manifest = { files: [], replaced: [], missing: [] };

  const files = await glob(`${DATA_DIR}/**/*.{md,mdx,markdown}`, { nodir: true });
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const fm = matter(raw);
    const body = fm.content;

    const slug = norm(fm.data.slug) || norm(path.basename(file).replace(/\.(md|mdx|markdown)$/i, ""));
    const date = fm.data.pubDatetime ? new Date(fm.data.pubDatetime) : new Date();
    const dateStr = date.toISOString().slice(0, 10);

    let changed = false;
    let newBody = body;

    // 1) [AffiliateLink_SKU] -> URL
    newBody = newBody.replaceAll(RE_SQUARE, (_m, rawSku) => {
      const sku = normSKU(rawSku);
      const row = chooseRow(affRows, sku, null);
      if (!row) {
        manifest.missing.push({ token: `[AffiliateLink_${rawSku}]`, reason: "SKU not found", file });
        return `[AffiliateLink_${rawSku}]`;
      }
      const { url } = buildLink(row, { postSlug: slug, dateStr }, {});
      manifest.replaced.push({ token: `[AffiliateLink_${rawSku}]`, url, file, rendered: "url" });
      changed = true;
      return url;
    });

    // 2) {{aff:SKU|...}} -> link/button/card
    newBody = newBody.replaceAll(RE_CURLY, (_m, rawSku, pipe = "") => {
      const sku = normSKU(rawSku);
      const opts = parseOpts(pipe);
      const row = chooseRow(affRows, sku, opts.country || null);
      if (!row) {
        manifest.missing.push({ token: `{{aff:${rawSku}${pipe}}}`, reason: "SKU not found", file });
        return `{{aff:${rawSku}${pipe}}}`;
      }

      const { url, resolved } = buildLink(row, { postSlug: slug, dateStr }, opts);
      const as = (opts.as || "").toLowerCase();

      if (as === "link") {
        const text = opts.text || "Get it here";
        manifest.replaced.push({ token: `{{aff:${rawSku}${pipe}}}`, url, rendered: "markdown-link", file });
        changed = true;
        return `[${text}](${url})`;
      }

      if (as === "button") {
        const text = opts.text || AFF_BUTTON_TEXT;
        const cls = opts.class || AFF_BUTTON_CLASS;
        const target = opts.target || AFF_BUTTON_TARGET;
        const rel = opts.rel || AFF_BUTTON_REL;
        const html =
          `<a class="${escapeHtml(cls)}" href="${escapeHtml(url)}" target="${escapeHtml(target)}" rel="${escapeHtml(rel)}"` +
          ` data-sku="${escapeHtml(sku)}" data-source="${escapeHtml(resolved.source)}"` +
          ` data-medium="${escapeHtml(resolved.medium)}" data-campaign="${escapeHtml(resolved.campaign)}"` +
          ` data-country="${escapeHtml(resolved.country)}" data-post="${escapeHtml(slug)}">` +
          `${escapeHtml(text)}</a>`;
        manifest.replaced.push({ token: `{{aff:${rawSku}${pipe}}}`, url, rendered: "html-button", file });
        changed = true;
        return html;
      }

      if (as === "card") {
        const p = productMap.get(sku) || { name: "", image: "" };
        // New: don't show SKU as fallback title. Only show if we have a real name or user provided title.
        const computedTitle = (opts.title ?? p.name ?? "").trim();
        const showTitle = !(String(opts.notitle || "").toLowerCase() === "true") && computedTitle !== "";

        const imgUrl = (opts.image || p.image || "").trim();
        const cardCls = opts.cardClass || AFF_CARD_CLASS;
        const imgCls = opts.imgClass || AFF_CARD_IMG_CLASS;
        const bodyCls = opts.bodyClass || AFF_CARD_BODY_CLASS;
        const titleCls = opts.titleClass || AFF_CARD_TITLE_CLASS;
        const ctaCls = opts.ctaClass || AFF_CARD_CTA_CLASS;
        const target = opts.target || AFF_BUTTON_TARGET;
        const rel = opts.rel || AFF_BUTTON_REL;
        const text = opts.text || AFF_BUTTON_TEXT;

        // New: allow width override per token or globally via .env
        const imgWidth = (opts.imgWidth || AFF_CARD_IMG_WIDTH || "").trim();
        const imgStyle = imgWidth ? ` style="width:${escapeHtml(imgWidth)}px;height:auto"` : "";

        const noImg = !imgUrl;
        const containerCls = noImg ? `${cardCls} aff-card--noimg` : cardCls;

        const imgHtml = imgUrl
          ? `<img class="${escapeHtml(imgCls)}" src="${escapeHtml(imgUrl)}" alt="${escapeHtml(computedTitle || sku)}"${imgStyle}>`
          : "";

        const titleHtml = showTitle
          ? `<div class="${escapeHtml(titleCls)}">${escapeHtml(computedTitle)}</div>`
          : "";

        const html =
          `<div class="${escapeHtml(containerCls)}" data-sku="${escapeHtml(sku)}">` +
            `${imgHtml}` +
            `<div class="${escapeHtml(bodyCls)}">` +
              `${titleHtml}` +
              `<a class="${escapeHtml(ctaCls)}" href="${escapeHtml(url)}" target="${escapeHtml(target)}" rel="${escapeHtml(rel)}"` +
                ` data-source="${escapeHtml(resolved.source)}" data-medium="${escapeHtml(resolved.medium)}"` +
                ` data-campaign="${escapeHtml(resolved.campaign)}" data-country="${escapeHtml(resolved.country)}" data-post="${escapeHtml(slug)}">` +
                `${escapeHtml(text)}</a>` +
            `</div>` +
          `</div>`;

        manifest.replaced.push({ token: `{{aff:${rawSku}${pipe}}}`, url, rendered: "html-card", file });
        changed = true;
        return html;
      }

      // default: URL
      manifest.replaced.push({ token: `{{aff:${rawSku}${pipe}}}`, url, rendered: "url", file });
      changed = true;
      return url;
    });

    if (changed) {
      const out = matter.stringify(newBody, fm.data);
      await writeFile(file, out, "utf8");
      manifest.files.push({ file, changed: true });
    } else {
      manifest.files.push({ file, changed: false });
    }
  }

  await writeFile(MANIFEST_OUT, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`Affiliate injection finished. Updated ${manifest.files.filter(f => f.changed).length}/${files.length} files.`);
  if (manifest.missing.length) console.warn("Missing:", manifest.missing);
}

run().catch(e => { console.error(e); process.exit(1); });
