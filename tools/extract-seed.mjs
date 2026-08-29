/**
 * One-shot extraction of the seed dataset from the imported design file into
 * `src/data/seed.js`, so the data is transferred verbatim rather than retyped.
 *
 * Run: node tools/extract-seed.mjs
 */
import fs from 'node:fs';

const SRC = 'design/Business Management App.dc.html';
const OUT = 'src/data/seed.js';

const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
const slice = (from, to) => lines.slice(from - 1, to).join('\n');

/** Class-field block -> exported const. */
function field(from, to, exportName) {
  const body = slice(from, to).replace(/^\s*[A-Za-z]+\s*=\s*/, '');
  return `export const ${exportName} = ${body.replace(/;\s*$/, '')};\n`;
}

/** `key:[ ... ]` entry inside the state object -> exported const. */
function stateEntry(from, to, exportName) {
  let body = slice(from, to).replace(/^\s*[A-Za-z]+\s*:\s*/, '');
  body = body.replace(/,\s*$/, '');
  return `export const ${exportName} = ${body};\n`;
}

const parts = [
  `/**
 * Seed dataset for the Business Management App.
 *
 * Extracted verbatim from the imported Claude Design project by
 * \`tools/extract-seed.mjs\`. This module is the only place record data lives;
 * everything reaches it through \`src/data/repository.js\`, which is the seam a
 * real HTTP API would replace.
 */\n`,
  field(1422, 1422, 'COMPANY'),
  field(1424, 1446, 'NAV'),
  field(1448, 1463, 'TITLES'),
  field(1465, 1472, 'CUSTOMERS'),
  field(1474, 1480, 'SUPPLIERS'),
  field(1482, 1490, 'COMPANIES'),
  field(1492, 1499, 'PRODUCTS'),
  field(1501, 1501, 'CROPS'),
  field(1502, 1502, 'WAREHOUSES'),
  field(1503, 1503, 'UNITS'),
  field(1504, 1504, 'GRADES'),
  field(1505, 1505, 'BUYERS'),
  field(1506, 1506, 'LAST_RATE'),
  stateEntry(1520, 1527, 'BATCHES'),
  stateEntry(1528, 1535, 'APPROVALS'),
  stateEntry(1536, 1542, 'CROP_LOG'),
  stateEntry(1543, 1548, 'SALE_LOG'),
  stateEntry(1549, 1556, 'NOTIFICATIONS'),
];

fs.mkdirSync('src/data', { recursive: true });
fs.writeFileSync(OUT, parts.join('\n'), 'utf8');
console.log(`wrote ${OUT} (${parts.length - 1} exports)`);
