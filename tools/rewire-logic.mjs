/**
 * Replace the inline dataset literals in `src/app/logic.js` with imports from
 * the data layer. Companion to `tools/extract-datasets.mjs`; run that first.
 *
 * Run: node tools/rewire-logic.mjs
 */
import fs from 'node:fs';

const LOGIC = 'src/app/logic.js';
let src = fs.readFileSync(LOGIC, 'utf8');

/** Character span of the bracket-balanced literal that follows `token`. */
function span(text, token) {
  const at = text.indexOf(token);
  if (at === -1) throw new Error(`token not found: ${token}`);
  let i = at + token.length;
  let depth = 0;
  let started = false;
  let inStr = null;

  for (; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '[' || ch === '{') { depth++; started = true; }
    if (ch === ']' || ch === '}') depth--;
    if (started && depth === 0) return { from: at + token.length, to: i + 1 };
  }
  throw new Error(`unbalanced literal after: ${token}`);
}

// token in logic.js -> replacement expression
const SWAPS = [
  ['const K =', 'DASHBOARD_KPIS'],
  ['const months =', 'MONTHLY_SERIES'],
  ['const topCust =', 'TOP_CUSTOMERS'],
  ['const topCo =', 'TOP_COMPANIES'],
  ['const aging =', 'AGING_BUCKETS'],
  ['const pl =', 'PROFIT_AND_LOSS'],
  ['const groups =', 'REPORT_GROUPS'],
  ['const empSet =', 'EMPLOYEES'],
  ['matrix:', 'PERMISSION_MATRIX'],
  ['phones:', 'PHONE_SCREENS'],
  ['setFy:', 'FINANCIAL_YEARS'],
  ['setNum:', 'NUMBERING'],
  ['setUnits:', 'UNIT_CONVERSIONS'],
  ['setPay:', 'PAYMENT_METHODS'],
  ['setNotif:', 'NOTIFICATION_RULES'],
];

// Resolve every span against the original text first, then splice back to
// front so earlier offsets stay valid.
const edits = SWAPS.map(([token, expr]) => {
  const { from, to } = span(src, token);
  return { from, to, expr };
}).sort((a, b) => b.from - a.from);

for (const e of edits) {
  src = src.slice(0, e.from) + ' ' + e.expr + src.slice(e.to);
}

src = src.replace(
  "import { cell, column, table } from '../components/dataTable.js';",
  `import { cell, column, table } from '../components/dataTable.js';
import {
  DASHBOARD_KPIS,
  MONTHLY_SERIES,
  TOP_CUSTOMERS,
  TOP_COMPANIES,
  AGING_BUCKETS,
  PROFIT_AND_LOSS,
  REPORT_GROUPS,
} from '../data/analytics.js';
import {
  EMPLOYEES,
  PERMISSION_MATRIX,
  PHONE_SCREENS,
  FINANCIAL_YEARS,
  NUMBERING,
  UNIT_CONVERSIONS,
  PAYMENT_METHODS,
  NOTIFICATION_RULES,
} from '../data/reference.js';`
);

fs.writeFileSync(LOGIC, src, 'utf8');
console.log(`rewired ${edits.length} datasets; logic.js is now ${src.split('\n').length} lines`);
