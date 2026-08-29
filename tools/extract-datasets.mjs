/**
 * Move the remaining hard-coded datasets out of `src/app/logic.js` into the
 * data layer, so the screen logic assembles view-models and the data modules
 * own the records.
 *
 * Run: node tools/extract-datasets.mjs
 */
import fs from 'node:fs';

const LOGIC = 'src/app/logic.js';
const src = fs.readFileSync(LOGIC, 'utf8');
const lines = src.split(/\r?\n/);

/**
 * Read a bracket-balanced literal starting at `startLine` (1-based), beginning
 * from the first `[` or `{` at or after `afterToken`.
 * @returns {{text: string, start: number, end: number}}
 */
function readLiteral(startLine, afterToken) {
  const from = startLine - 1;
  let i = from;
  let col = lines[i].indexOf(afterToken);
  if (col === -1) throw new Error(`token "${afterToken}" not on line ${startLine}`);
  col += afterToken.length;

  let depth = 0;
  let started = false;
  let inStr = null;
  let out = '';

  for (; i < lines.length; i++) {
    const line = lines[i];
    for (let c = i === from ? col : 0; c < line.length; c++) {
      const ch = line[c];
      if (inStr) {
        if (ch === '\\') { out += ch + line[++c]; continue; }
        if (ch === inStr) inStr = null;
        out += ch;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; out += ch; continue; }
      if (ch === '[' || ch === '{') { depth++; started = true; }
      if (ch === ']' || ch === '}') depth--;
      out += ch;
      if (started && depth === 0) return { text: out.trim(), start: startLine, end: i + 1 };
    }
    out += '\n';
  }
  throw new Error(`unbalanced literal from line ${startLine}`);
}

const grab = (line, token) => readLiteral(line, token).text;

/* ---------------------------------------------------------------- analytics */

const analytics = `import { C } from '../styles/tokens.js';

/**
 * Reporting figures for the dashboard, accounts and reports centre.
 *
 * These are the aggregates an analytics endpoint would serve. They are kept
 * out of the screen logic so a real backend can replace this module wholesale
 * without touching a view.
 */

/** Headline KPI tiles. \`d\` is the dealer figure, \`c\` the bulk crop figure. */
export const DASHBOARD_KPIS = ${grab(238, 'const K =')};

/** Monthly sales/purchase series, in lakh BDT, split by business line. */
export const MONTHLY_SERIES = ${grab(252, 'const months =')};

/** Best customers by sales value. */
export const TOP_CUSTOMERS = ${grab(266, 'const topCust =')};

/** Best counterparty companies by traded value. */
export const TOP_COMPANIES = ${grab(267, 'const topCo =')};

/** Receivable aging buckets. */
export const AGING_BUCKETS = ${grab(269, 'const aging =')};

/** Profit and loss lines for the current month. */
export const PROFIT_AND_LOSS = ${grab(397, 'const pl =')};

/** Report catalogue shown in the reports centre sidebar. */
export const REPORT_GROUPS = ${grab(413, 'const groups =')};
`;

/* ---------------------------------------------------------------- reference */

const reference = `import { C } from '../styles/tokens.js';
import { money } from '../domain/format.js';

/**
 * Reference and configuration records: the team directory, the audit trail,
 * the permission matrix, the settings pages and the mobile screen specs.
 *
 * Separate from \`analytics.js\` because these are records a system-of-record
 * would own rather than figures a reporting endpoint would compute.
 */

/** Team directory: id, name, designation, department, mobile, role, joined. */
export const EMPLOYEES = ${grab(506, 'const empSet =')};

/** Which role may do what, per module. */
export const PERMISSION_MATRIX = ${grab(554, 'matrix:')};

/** Field-entry and approval screens for the phone. */
export const PHONE_SCREENS = ${grab(599, 'phones:')};

/** Financial years, most recent first. */
export const FINANCIAL_YEARS = ${grab(583, 'setFy:')};

/** Document numbering patterns. */
export const NUMBERING = ${grab(586, 'setNum:')};

/** Units and their conversion to the base unit. */
export const UNIT_CONVERSIONS = ${grab(588, 'setUnits:')};

/** Payment methods and whether each is in use. */
export const PAYMENT_METHODS = ${grab(590, 'setPay:')};

/** Notification rules and when each fires. */
export const NOTIFICATION_RULES = ${grab(596, 'setNotif:')};
`;

fs.writeFileSync('src/data/analytics.js', analytics, 'utf8');
fs.writeFileSync('src/data/reference.js', reference, 'utf8');
console.log('wrote src/data/analytics.js and src/data/reference.js');
