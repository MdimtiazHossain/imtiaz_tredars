/**
 * One-shot port of the screen logic from the imported design file into
 * `src/app/logic.js`.
 *
 * The design's view-model methods are transferred mechanically rather than
 * retyped, then rebound onto this project's modules: formatting moves to
 * `domain/format`, table building to `components/dataTable`, colours to
 * `styles/tokens`, and master data to the repository-loaded `this.data`.
 *
 * Run: node tools/extract-logic.mjs
 */
import fs from 'node:fs';

const SRC = 'design/Business Management App.dc.html';
const OUT = 'src/app/logic.js';

const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
const slice = (from, to) => lines.slice(from - 1, to).join('\n');

/** Master-data fields become repository-loaded properties on `this.data`. */
const DATA_FIELDS = {
  CUSTOMERS: 'customers',
  SUPPLIERS: 'suppliers',
  COMPANIES: 'companies',
  PRODUCTS: 'products',
  CROPS: 'crops',
  WAREHOUSES: 'warehouses',
  UNITS: 'units',
  GRADES: 'grades',
  BUYERS: 'buyers',
  LASTRATE: 'lastRate',
  NAV: 'nav',
  TITLES: 'titles',
  CO: 'company',
};

/** Helper methods that moved out to shared modules. */
const HELPERS = {
  'this.m(': 'money(',
  'this.n0(': 'int(',
  'this.n2(': 'dec2(',
  'this.lac(': 'lakh(',
  'this.cel(': 'cell(',
  'this.col(': 'column(',
  'this.tbl(': 'table(',
};

function rebind(src) {
  let out = src;
  for (const [from, to] of Object.entries(HELPERS)) {
    out = out.split(from).join(to);
  }
  out = out.replace(/\bthis\.C\./g, 'C.');
  for (const [field, prop] of Object.entries(DATA_FIELDS)) {
    out = out.replace(new RegExp(`\\bthis\\.${field}\\b`, 'g'), `this.data.${prop}`);
  }
  return out;
}

const uiState = rebind(slice(1509, 1519)).replace(/,\s*$/, '');
const methods = rebind(slice(1571, 2129));

const header = `/**
 * Screen logic for the Business Management App.
 *
 * Ported from the imported Claude Design project by \`tools/extract-logic.mjs\`.
 * Each method assembles the view-model for one screen; the templates in
 * \`src/templates\` consume it. Master data arrives from the repository as
 * \`this.data\`, and writes are sent back through the repository rather than
 * mutated in place only.
 */
import { Component } from '../runtime/component.js';
import { C } from '../styles/tokens.js';
import { money, int, dec2, lakh } from '../domain/format.js';
import { cell, column, table } from '../components/dataTable.js';

export class BusinessApp extends Component {
  /**
   * @param {object} props  role, showProfit, approvalLimit, repository
   * @param {object} data   working set loaded by the repository
   */
  constructor(props, data) {
    super(props);
    this.data = data;
    this.repository = props.repository || null;
    this.state = {
${uiState.replace(/^/gm, '  ')},
      batches: data.batches,
      approvals: data.approvals,
      cropLog: data.cropLog,
      saleLog: data.saleLog,
      notifs: data.notifications,
    };
  }

`;

fs.mkdirSync('src/app', { recursive: true });
fs.writeFileSync(OUT, header + methods + '\n}\n', 'utf8');
console.log(`wrote ${OUT}`);
