/**
 * Splits soato_seed.json into one file per region under ./regions/
 * Each file contains: the region row + its districts + their settlements.
 *
 * Run: node split-by-region.js
 */

const fs   = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'soato_seed.json');
const OUT = path.join(__dirname, 'regions');

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

const all = JSON.parse(fs.readFileSync(SRC, 'utf-8'));

// Index for quick look-up
const byCode = {};
for (const e of all) byCode[e.code] = e;

const regions = all.filter(e => e.level === 2);

for (const region of regions) {
  const regionCode = region.code;

  // All districts whose parent_code = regionCode
  const districts = all.filter(e => e.level === 3 && e.parent_code === regionCode);

  // All settlements whose code starts with regionCode (4 digits)
  const settlements = all.filter(e => e.level === 4 && e.code.startsWith(regionCode));

  const slug = region.name_uz
    ? region.name_uz.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/(^-|-$)/g, '')
    : regionCode;

  const fileName = `${regionCode}-${slug}.json`;
  const filePath = path.join(OUT, fileName);

  const payload = [region, ...districts, ...settlements];
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');

  console.log(`${fileName}  →  1 region + ${districts.length} districts + ${settlements.length} settlements`);
}

console.log(`\nDone. ${regions.length} files written to ./regions/`);
