/**
 * Merges all ./regions/*.json files back into soato_seed.json,
 * copies it to dist, then calls POST /api/soato/seed.
 *
 * Run after you finish editing individual region files:
 *   node merge-and-seed.js
 */

const fs   = require('fs');
const path = require('path');
const http = require('http');

const REGIONS_DIR = path.join(__dirname, 'regions');
const SRC         = path.join(__dirname, 'soato_seed.json');
const DIST        = path.join(__dirname, '..', '..', '..', 'dist', 'scripts', 'soato', 'soato_seed.json');
const SEED_URL    = 'http://localhost:3000/api/soato/seed';

// Country root row — always first
const countryRow = {
  code: '17',
  name_uz: "O'zbekiston Respublikasi",
  name_ru: 'Республика Узбекистан',
  parent_code: null,
  level: 1,
};

// Read all region files and merge
const files = fs.readdirSync(REGIONS_DIR).filter(f => f.endsWith('.json')).sort();
const merged = [countryRow];

for (const file of files) {
  const rows = JSON.parse(fs.readFileSync(path.join(REGIONS_DIR, file), 'utf-8'));
  merged.push(...rows);
  console.log(`  merged: ${file} (${rows.length} rows)`);
}

// Write back to src
fs.writeFileSync(SRC, JSON.stringify(merged), 'utf-8');
console.log(`\nWrote ${merged.length} rows → soato_seed.json`);

// Copy to dist
if (fs.existsSync(path.dirname(DIST))) {
  fs.writeFileSync(DIST, JSON.stringify(merged), 'utf-8');
  console.log('Copied → dist/');
} else {
  console.warn('dist/ not found — skipping copy');
}

// Call seed endpoint
console.log('\nCalling POST /api/soato/seed …');
const req = http.request(SEED_URL, { method: 'POST' }, res => {
  let body = '';
  res.on('data', chunk => (body += chunk));
  res.on('end', () => {
    const result = JSON.parse(body);
    if (result.success) {
      console.log(`Done: regions=${result.regions} districts=${result.districts} settlements=${result.settlements} (${result.elapsedMs}ms)`);
    } else {
      console.error('Seed failed:', result.error);
    }
  });
});
req.on('error', e => console.error('Request error:', e.message));
req.end();
