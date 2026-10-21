/**
 * Parses SOATO .doc (HTML) → extracts code→name_ru map
 * Table structure: | code | name_ru | center |
 * Empty cells ARE in the HTML but filtered out — we keep them.
 */

const fs   = require('fs');
const path = require('path');

const DOC = path.join(
  __dirname, '..', '..', '..', '..',
  'СОАТО_Система_обозначения_административно-территориальных_образований(2).doc'
);

const raw = fs.readFileSync(DOC, 'utf8');

// Grab ALL <td> cells, including empty ones
const tdMatches = [...raw.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
const cells = tdMatches.map(m =>
  m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
);

console.log('Total cells (incl empty):', cells.length);

// Table is 3 columns: code | name_ru | center
// Skip the 3-cell header row
const codeRu = {};
let i = 3; // skip header

while (i < cells.length) {
  const code = cells[i];
  const name_ru = cells[i + 1] || null;
  // cells[i+2] = center (ignored)
  i += 3;

  // Only keep rows where code looks like a SOATO code
  if (/^1[0-9]{1,9}$/.test(code) && name_ru) {
    codeRu[code] = name_ru;
  }
}

console.log('Parsed code→name_ru entries:', Object.keys(codeRu).length);

// Spot-check
['17','1703','1706','1708','1710','1712','1714','1718','1722','1724','1726','1727','1730','1733','1735'].forEach(c => {
  console.log(c, '->', codeRu[c] || 'NOT FOUND');
});

const OUT = path.join(__dirname, 'doc_parsed.json');
fs.writeFileSync(OUT, JSON.stringify(codeRu, null, 2), 'utf-8');
console.log('\nSaved to doc_parsed.json');
