/**
 * Parses soato(mhobt)_2020.xlsx and rebuilds soato_seed.json with
 * correct name_uz (col B) and name_ru (col F) from the official Excel.
 *
 * Columns: A=code  B=name_uz  C=center_uz  D=?  E=?  F=name_ru  G=center_ru
 *
 * Run: node parse-xlsx.js
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const XLSX   = 'c:/Users/user/Desktop/humora/soato(mhobt)_2020.xlsx';
const TMPDIR = 'C:/Users/user/AppData/Local/Temp/soato_xlsx/extracted';
const SEED   = path.join(__dirname, 'soato_seed.json');
const DIST   = path.join(__dirname, '../../../dist/scripts/soato/soato_seed.json');
const REGIONS_DIR = path.join(__dirname, 'regions');

// Step 1: pre-run in bash:
//   mkdir -p /tmp/soato_xlsx && cp "...xlsx" /tmp/soato_xlsx/x.xlsx
//   cd /tmp/soato_xlsx && unzip -o x.xlsx -d extracted
// (already done — files are in TMPDIR)

// ── Step 2: Parse sharedStrings.xml ─────────────────────────────────────────
const ssXml  = fs.readFileSync(`${TMPDIR}/xl/sharedStrings.xml`, 'utf8');
const strings = [];
for (const m of ssXml.matchAll(/<si><t(?:[^>]*)>([\s\S]*?)<\/t><\/si>/g)) {
  strings.push(m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim());
}
console.log('Shared strings:', strings.length);

// ── Step 3: Parse sheet1.xml row by row ─────────────────────────────────────
const sheetXml = fs.readFileSync(`${TMPDIR}/xl/worksheets/sheet1.xml`, 'utf8');
const rows = {};  // rowNum → { A, B, F }

for (const rowMatch of sheetXml.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
  const rowNum = parseInt(rowMatch[1]);
  if (rowNum < 5) continue; // skip headers

  const rowData = {};
  for (const cellMatch of rowMatch[2].matchAll(/<c r="([A-Z]+)\d+" [^>]*t="s"[^>]*><v>(\d+)<\/v><\/c>/g)) {
    rowData[cellMatch[1]] = strings[parseInt(cellMatch[2])] || null;
  }
  // Numeric cells (codes)
  for (const cellMatch of rowMatch[2].matchAll(/<c r="([A-Z]+)\d+"[^>]*><v>(\d+)<\/v><\/c>/g)) {
    if (!rowData[cellMatch[1]]) rowData[cellMatch[1]] = cellMatch[2];
  }
  if (rowData.A) rows[rowNum] = rowData;
}

console.log('Data rows:', Object.keys(rows).length);

// ── Step 4: Build code → { name_uz, name_ru } lookup ────────────────────────
const lookup = {};
for (const [, row] of Object.entries(rows)) {
  const code = String(row.A).trim();
  if (!/^1[0-9]{1,9}$/.test(code)) continue;
  lookup[code] = {
    name_uz: row.B || null,
    name_ru: row.F || null,
  };
}
console.log('Code lookup entries:', Object.keys(lookup).length);

// Spot check level-2 regions
['1703','1706','1708','1710','1712','1714','1718','1722','1724','1726','1727','1730','1733','1735'].forEach(c => {
  const e = lookup[c];
  console.log(c, '|', e ? e.name_uz : 'NOT FOUND', '|', e ? e.name_ru : 'NOT FOUND');
});

// ── Step 5: Rebuild soato_seed.json ─────────────────────────────────────────
const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));

let updUz = 0, updRu = 0, addedCodes = 0;

for (const entry of seed) {
  const src = lookup[entry.code];
  if (!src) continue;

  if (src.name_uz && src.name_uz !== entry.name_uz) { entry.name_uz = src.name_uz; updUz++; }
  if (src.name_ru && src.name_ru !== entry.name_ru) { entry.name_ru = src.name_ru; updRu++; }
}

// Add codes present in Excel but missing from seed
const existingCodes = new Set(seed.map(e => e.code));
for (const [code, names] of Object.entries(lookup)) {
  if (existingCodes.has(code)) continue;

  let level, parent_code;
  if (code.length === 4)  { level = 2; parent_code = '17'; }
  else if (code.length === 7)  { level = 3; parent_code = code.slice(0, 4); }
  else if (code.length === 10) { level = 4; parent_code = code.slice(0, 7); }
  else { console.log(`[SKIP unknown length] ${code}`); continue; }

  seed.push({ code, name_uz: names.name_uz, name_ru: names.name_ru, parent_code, level });
  addedCodes++;
}

// Sort seed: level1 first, then level2 by code, then level3/4 by code
seed.sort((a, b) => {
  if (a.level !== b.level) return a.level - b.level;
  return a.code.localeCompare(b.code);
});

console.log(`\nUpdated: name_uz=${updUz}  name_ru=${updRu}`);
console.log(`Codes in Excel but not in seed: ${addedCodes}`);

const nullUz = seed.filter(e => !e.name_uz).length;
const nullRu = seed.filter(e => !e.name_ru).length;
console.log(`Remaining nulls → name_uz: ${nullUz}  name_ru: ${nullRu}`);

// Write seed
fs.writeFileSync(SEED, JSON.stringify(seed), 'utf8');
console.log('\nWrote soato_seed.json');

// Copy to dist
if (fs.existsSync(path.dirname(DIST))) {
  fs.writeFileSync(DIST, JSON.stringify(seed), 'utf8');
  console.log('Copied to dist/');
}

// Rebuild region files
if (!fs.existsSync(REGIONS_DIR)) fs.mkdirSync(REGIONS_DIR);
for (const f of fs.readdirSync(REGIONS_DIR)) fs.unlinkSync(path.join(REGIONS_DIR, f));

const level2 = seed.filter(e => e.level === 2);
for (const region of level2) {
  const rc   = region.code;
  const rows2 = [region,
    ...seed.filter(e => e.level === 3 && e.parent_code === rc),
    ...seed.filter(e => e.level === 4 && e.code.startsWith(rc)),
  ];
  const slug = (region.name_uz || rc)
    .toLowerCase().replace(/[^a-z0-9]/g,'-').replace(/-+/g,'-').replace(/(^-|-$)/g,'');
  fs.writeFileSync(path.join(REGIONS_DIR, `${rc}-${slug}.json`), JSON.stringify(rows2, null, 2), 'utf8');
}
console.log(`Rebuilt ${level2.length} region files in ./regions/`);
console.log('\nDone. Run: POST /api/soato/seed');
