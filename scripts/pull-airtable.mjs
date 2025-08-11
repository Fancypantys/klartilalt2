// scripts/pull-airtable.mjs
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const {
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE_ID,
  AIRTABLE_VIEW_ID,
} = process.env;

if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE_ID) {
  console.error('❌ Missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID or AIRTABLE_TABLE_ID in .env');
  process.exit(1);
}

const outRoot = path.join(process.cwd(), 'src', 'data', 'blog');
// Ensure base folder exists
fs.mkdirSync(outRoot, { recursive: true });

const apiBase = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`;

async function fetchAll() {
  let url = new URL(apiBase);
  if (AIRTABLE_VIEW_ID) url.searchParams.set('view', AIRTABLE_VIEW_ID);

  const headers = { Authorization: `Bearer ${AIRTABLE_TOKEN}` };
  let records = [];
  for (;;) {
    const res = await fetch(url, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`Airtable error ${res.status}: ${text}`);
    const data = JSON.parse(text);
    records.push(...(data.records || []));
    if (!data.offset) break;

    url = new URL(apiBase);
    if (AIRTABLE_VIEW_ID) url.searchParams.set('view', AIRTABLE_VIEW_ID);
    url.searchParams.set('offset', data.offset);
  }
  return records;
}

const slugify = (str = '') =>
  str.toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 120);

const fm = (obj) =>
  `---\n${Object.entries(obj).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`;
    if (v instanceof Date) return `${k}: ${v.toISOString()}`;
    if (typeof v === 'string') return `${k}: ${JSON.stringify(v)}`;
    return `${k}: ${v}`;
  }).join('\n')}\n---\n\n`;

const toPlain = (md = '') =>
  md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^\)]*\)/g, ' ')
    .replace(/\[[^\]]*\]\([^\)]*\)/g, ' ')
    .replace(/[#>*_~`>-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

(async () => {
  console.log('🔄 Pulling posts from Airtable…');
  const rows = await fetchAll();

  let written = 0;
  for (const r of rows) {
    const f = r.fields || {};

    const title = (f.title || f.Title || '').trim();
    if (!title) continue;

    const slug = (f.slug || f.Slug || '').trim() || slugify(title);
    const categoryRaw = (f.category || f.Category || '').toString();
    const category = categoryRaw.toLowerCase().trim();

    const tags = Array.isArray(f.tags) ? f.tags : (Array.isArray(f.Tags) ? f.Tags : []);
    const pubDtRaw = f.pubDatetime || f.pubdatetime || f.PubDatetime || f.PubDT || null;
    const ogImage = f.ogImage || f.ogimage || null;

    const body = (f.body ?? f.Body ?? '').toString().trim();
    const descFromAirtable = (f.description ?? f.Description ?? '').toString().trim();

    // Ensure required fields for Astro schema
    const pubDatetime = pubDtRaw ? new Date(pubDtRaw) : new Date(); // fallback = now
    const description = (descFromAirtable || toPlain(body) || title).slice(0, 160);

    const frontmatter = {
      title,
      slug,
      draft: false,
      pubDatetime: pubDatetime.toISOString(),
      description,
      ...(category ? { category } : {}),
      ...(tags?.length ? { tags } : {}),
      ...(ogImage ? { ogImage } : {}),
    };

    // Map category to subfolder (unknown -> root)
    const categoryFolder =
      category === 'roundups' ? 'roundups' :
      category === 'guides'   ? 'guides'   :
      category === 'gear'     ? 'gear'     :
      category === 'kits'     ? 'kits'     :
      '';

    const outDir = categoryFolder ? path.join(outRoot, categoryFolder) : outRoot;
    fs.mkdirSync(outDir, { recursive: true });

    const outPath = path.join(outDir, `${slug}.md`);

    const safeBody =
      body ||
      (descFromAirtable
        ? `${descFromAirtable}\n\n*(Fuldt indhold kommer snart.)*\n`
        : '*(Fuldt indhold kommer snart.)*\n');

    const content = `${fm(frontmatter)}${safeBody}\n`;
    fs.writeFileSync(outPath, content, 'utf-8');
    written++;
  }

  console.log(`✅ Wrote ${written} markdown file(s) into src/data/blog${written ? '' : ' (nothing to write)'}.`);
})().catch((e) => {
  console.error('❌ Sync failed:', e.message);
  process.exit(1);
});
