/**
 * Rebuilds soato_seed.json from two authoritative sources:
 *   - PDF  → name_uz  (pdftotext -layout output)
 *   - DOC  → name_ru  (HTML table, already parsed to doc_parsed.json)
 *
 * Strategy:
 *   1. Parse PDF → code:name_uz map
 *   2. Load DOC  → code:name_ru map (doc_parsed.json)
 *   3. Walk current seed.json (preserves level/parent_code structure)
 *   4. For each entry, replace name_uz and name_ru with authoritative values
 *      if available; keep existing value if source is empty.
 *   5. Write fixed soato_seed.json and rebuild all ./regions/ files.
 *
 * Run: node rebuild-from-sources.js
 */

const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');

const SOATO_DIR = __dirname;
const SEED      = path.join(SOATO_DIR, 'soato_seed.json');
const DOC_MAP   = path.join(SOATO_DIR, 'doc_parsed.json');
const PDF       = path.join(SOATO_DIR, '..', '..', '..', '..', 'SOATO enkbc.pdf');
const REGIONS   = path.join(SOATO_DIR, 'regions');

// ── 1. Parse PDF → code:name_uz ─────────────────────────────────────────────
console.log('Parsing PDF …');
const pdfText = execSync(`pdftotext -layout "${PDF}" -`, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });

const codeUz = {};
for (const line of pdfText.split('\n')) {
  const m = line.match(/^\s{0,4}(1[0-9]{1,9})\s{2,}(.+)/);
  if (!m) continue;
  const code    = m[1].trim();
  // name_uz is everything before the "center" column (usually > 40 chars from left)
  // grab up to the first run of 3+ spaces after the name
  const rest    = m[2].replace(/\s{3,}.*$/, '').trim();
  if (rest && rest.length > 1) codeUz[code] = rest;
}
console.log(`  PDF: ${Object.keys(codeUz).length} name_uz entries`);

// ── 2. Load DOC → code:name_ru ───────────────────────────────────────────────
console.log('Loading DOC map …');
const codeRu = JSON.parse(fs.readFileSync(DOC_MAP, 'utf-8'));

// Clean up spacing artifacts (e.g. "Х ОРЕЗМСКАЯ" → "ХОРЕЗМСКАЯ")
for (const [k, v] of Object.entries(codeRu)) {
  codeRu[k] = v.replace(/([А-ЯЁа-яё])\s([А-ЯЁа-яё])/g, '$1$2').trim();
}
console.log(`  DOC: ${Object.keys(codeRu).length} name_ru entries`);

// ── 3. Rebuild seed ───────────────────────────────────────────────────────────
console.log('Rebuilding seed …');
const seed = JSON.parse(fs.readFileSync(SEED, 'utf-8'));

let fixedUz = 0, fixedRu = 0, keptUz = 0, keptRu = 0;

for (const entry of seed) {
  const pdfUz = codeUz[entry.code] || null;
  const docRu = codeRu[entry.code] || null;

  if (pdfUz && pdfUz !== entry.name_uz) {
    entry.name_uz = pdfUz;
    fixedUz++;
  } else {
    keptUz++;
  }

  if (docRu && docRu !== entry.name_ru) {
    entry.name_ru = docRu;
    fixedRu++;
  } else {
    keptRu++;
  }
}

console.log(`  name_uz: ${fixedUz} updated, ${keptUz} kept`);
console.log(`  name_ru: ${fixedRu} updated, ${keptRu} kept`);

// ── 4. Write soato_seed.json ─────────────────────────────────────────────────
fs.writeFileSync(SEED, JSON.stringify(seed), 'utf-8');
console.log('Wrote soato_seed.json');

// ── 5. Rebuild regions/ files ────────────────────────────────────────────────
if (!fs.existsSync(REGIONS)) fs.mkdirSync(REGIONS);

// Remove old region files
for (const f of fs.readdirSync(REGIONS)) {
  fs.unlinkSync(path.join(REGIONS, f));
}

const level2 = seed.filter(e => e.level === 2);
for (const region of level2) {
  const rc   = region.code;
  const rows = [region,
    ...seed.filter(e => e.level === 3 && e.parent_code === rc),
    ...seed.filter(e => e.level === 4 && e.code.startsWith(rc)),
  ];
  const slug = (region.name_uz || rc)
    .toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/(^-|-$)/g, '');
  fs.writeFileSync(
    path.join(REGIONS, `${rc}-${slug}.json`),
    JSON.stringify(rows, null, 2), 'utf-8'
  );
}
console.log(`Rebuilt ${level2.length} region files in ./regions/`);

// ── 6. Stats: remaining nulls ─────────────────────────────────────────────────
const nullUz = seed.filter(e => !e.name_uz).length;
const nullRu = seed.filter(e => !e.name_ru).length;
console.log(`\nRemaining nulls → name_uz: ${nullUz}  name_ru: ${nullRu}`);

// Copy to dist
const DIST = path.join(SOATO_DIR, '..', '..', '..', 'dist', 'scripts', 'soato', 'soato_seed.json');
if (fs.existsSync(path.dirname(DIST))) {
  fs.writeFileSync(DIST, JSON.stringify(seed), 'utf-8');
  console.log('Copied to dist/');
}
console.log('\nDone. Run: POST /api/soato/seed');
