/**
 * Fixes incorrect SOATO level-2 (region) entries and obvious level-3
 * container header entries in soato_seed.json.
 *
 * Run once: node fix-soato.js
 * Then call: POST /api/soato/seed
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'soato_seed.json');
const data = JSON.parse(fs.readFileSync(FILE, 'utf-8'));

// ── Level-2 corrections ──────────────────────────────────────────────────────
const level2Fixes = {
  '1712': { name_uz: 'Navoiy viloyati',               name_ru: 'Навоийская область' },
  '1714': { name_uz: 'Namangan viloyati',             name_ru: 'Наманганская область' },
  '1722': { name_uz: 'Surxondaryo viloyati',          name_ru: 'Сурхандарьинская область' },
  '1726': { name_uz: 'Toshkent shahri',               name_ru: 'город Ташкент' },
  '1727': { name_uz: 'Toshkent viloyati',             name_ru: 'Ташкентская область' },
  '1730': { name_uz: "Farg'ona viloyati",             name_ru: 'Ферганская область' },
  '1733': { name_uz: 'Xorazm viloyati',               name_ru: 'Хорезмская область' },
  '1735': { name_uz: "Qoraqalpog'iston Respublikasi", name_ru: 'Республика Каракалпакстан' },
};

// ── Level-3 container/header corrections ─────────────────────────────────────
// These are grouping rows (codes ending in 200/211/etc.) that had wrong labels.
const level3Fixes = {
  // Navoiy grouping rows (parent 1712)
  '1712200': { name_uz: "Navoiy viloyatining shahar aholi punktlari", name_ru: 'Городские населённые пункты Навоийской области' },
  '1712211': { name_uz: "Navoiy viloyatining tumanlari",              name_ru: 'Районы Навоийской области' },

  // Namangan grouping rows (parent 1714)
  '1714200': { name_uz: "Namangan viloyatining shahar aholi punktlari", name_ru: 'Городские населённые пункты Наманганской области' },

  // Samarqand grouping rows (parent 1718) - label said "Namangan" instead of "Samarqand"
  '1718200': { name_uz: "Samarqand viloyatining viloyat ahamiyatidagi shaharlari", name_ru: 'Города областного подчинения Самаркандской области' },

  // Surxondaryo grouping rows (parent 1722)
  '1722200': { name_uz: "Surxondaryo viloyatining shahar aholi punktlari", name_ru: 'Городские населённые пункты Сурхандарьинской области' },

  // Toshkent shahri grouping row (parent 1726)
  '1726260': { name_uz: "Toshkent shahri tumanlari",         name_ru: 'Районы города Ташкента' },

  // Toshkent viloyati grouping rows (parent 1727)
  '1727200': { name_uz: "Toshkent viloyatining shahar aholi punktlari", name_ru: 'Городские населённые пункты Ташкентской области' },

  // Farg'ona grouping rows (parent 1730)
  '1730200': { name_uz: "Farg'ona viloyatining shahar aholi punktlari", name_ru: "Городские населённые пункты Ферганской области" },

  // Xorazm grouping rows (parent 1733)
  '1733200': { name_uz: "Xorazm viloyatining shahar aholi punktlari",  name_ru: 'Городские населённые пункты Хорезмской области' },
  '1733204': { name_uz: "Xorazm viloyatining tumanlari",               name_ru: 'Районы Хорезмской области' },

  // Qoraqalpogiston grouping rows (parent 1735)
  '1735200': { name_uz: "Qoraqalpog'iston Respublikasining shahar aholi punktlari", name_ru: 'Городские населённые пункты Республики Каракалпакстан' },
};

let fixed2 = 0;
let fixed3 = 0;

for (const entry of data) {
  if (entry.level === 2 && level2Fixes[entry.code]) {
    const fix = level2Fixes[entry.code];
    console.log(`[L2] ${entry.code}: "${entry.name_uz}" → "${fix.name_uz}" | "${entry.name_ru}" → "${fix.name_ru}"`);
    entry.name_uz = fix.name_uz;
    entry.name_ru = fix.name_ru;
    fixed2++;
  }
  if (level3Fixes[entry.code]) {
    const fix = level3Fixes[entry.code];
    console.log(`[L3] ${entry.code}: "${entry.name_uz}" → "${fix.name_uz}"`);
    entry.name_uz = fix.name_uz;
    entry.name_ru = fix.name_ru;
    fixed3++;
  }
}

// Add missing 1718 (Samarqand viloyati) level-2 entry after 1714
const idx1714 = data.findIndex(e => e.code === '1714');
const samarqandEntry = {
  code: '1718',
  name_uz: 'Samarqand viloyati',
  name_ru: 'Самаркандская область',
  parent_code: '17',
  level: 2,
};
if (!data.find(e => e.code === '1718')) {
  data.splice(idx1714 + 1, 0, samarqandEntry);
  console.log(`[ADD] 1718 Samarqand viloyati added at index ${idx1714 + 1}`);
}

fs.writeFileSync(FILE, JSON.stringify(data, null, 0), 'utf-8');
console.log(`\nDone: ${fixed2} level-2 fixed, ${fixed3} level-3 fixed, 1 region added.`);
console.log('Now call: POST /api/soato/seed');
