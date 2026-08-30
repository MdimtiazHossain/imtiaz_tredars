import fs from 'node:fs';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

/**
 * Report export.
 *
 * Both formats are built from the same `{ columns, rows }` a report already
 * returns, so an export cannot drift from what the screen shows. Column types
 * carry through: money is a real number with an accounting format in Excel
 * rather than a string, so the file can be summed and sorted on arrival.
 *
 * Exports are deliberately unpaged — a page of a report is a screen concern,
 * a file is the whole answer.
 */

/** Colours lifted from the design, so a file looks like the product. */
const INK = 'FF1A1817';
const MUTED = 'FF6E6A64';
const RULE = 'FFE3E0DA';
const HEADER_BG = 'FFFAF9F7';
const ACCENT = 'FF8A2233';

const isNumeric = (type) => type === 'money' || type === 'number' || type === 'percent';

/**
 * PDFKit's built-in fonts encode Latin-1 only, so a Bengali party name would
 * throw rather than render. Point PDF_FONT_PATH at a .ttf covering the scripts
 * you use — Noto Sans Bengali, for instance — and it is embedded instead.
 *
 * Excel has no such limit: .xlsx is UTF-8 throughout.
 */
const PDF_FONT_PATH = process.env.PDF_FONT_PATH || null;
const hasEmbeddedFont = Boolean(PDF_FONT_PATH && fs.existsSync(PDF_FONT_PATH));

if (PDF_FONT_PATH && !hasEmbeddedFont) {
  console.warn(`[export] PDF_FONT_PATH is set but not readable: ${PDF_FONT_PATH}`);
}

/**
 * Make a string safe for a Latin-1 font.
 *
 * Without an embedded font, characters outside Latin-1 are replaced rather
 * than allowed to throw: a report that exports with a placeholder beats one
 * that returns a 500 because a customer has a Bengali name. With a font
 * embedded the text passes through untouched.
 */
function pdfSafe(text) {
  const value = String(text ?? '');
  if (hasEmbeddedFont) return value;
  // Anything above U+00FF is outside WinAnsi, and control characters would
  // break a single-line table cell, so both are replaced.
  return value.replace(/[^ -ÿ]/g, '?');
}

/** Excel number formats matching how each type reads on screen. */
const NUMBER_FORMAT = {
  money: '#,##0;[Red]-#,##0',
  number: '#,##0.###',
  percent: '0.0"%"',
};

/** A filename that sorts and reads well: batch-wise-crop-profit-2026-08-30.xlsx */
export function exportFilename(label, extension) {
  const slug = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug}-${new Date().toISOString().slice(0, 10)}.${extension}`;
}

/** Human-readable description of the filters an export was run with. */
export function describeFilters(q) {
  const parts = [];
  if (q.from || q.to) parts.push(`Period ${q.from || 'start'} to ${q.to || 'today'}`);
  parts.push(
    `Business type ${
      q.businessType === 'ALL'
        ? 'All'
        : q.businessType === 'DEALER'
          ? 'Dealer'
          : 'Bulk Crop'
    }`
  );
  return parts.join(' · ');
}

/* ------------------------------------------------------------------- excel */

/**
 * Build an .xlsx workbook.
 * @param {{title:string, subtitle:string, columns:Array, rows:Array, totals:object}} report
 * @returns {Promise<Buffer>}
 */
export async function buildWorkbook(report) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Meghna Agro Enterprise — Business Suite';
  workbook.created = new Date();

  // Excel refuses \ / ? * [ ] in a sheet name, and caps it at 31 characters.
  const sheetName = report.title.replace(/[\\/?*[\]]/g, '-').slice(0, 31);
  const sheet = workbook.addWorksheet(sheetName, {
    views: [{ state: 'frozen', ySplit: 3 }],
  });

  const width = report.columns.length;

  const titleRow = sheet.addRow([report.title]);
  titleRow.font = { size: 14, bold: true, color: { argb: INK } };
  sheet.mergeCells(1, 1, 1, Math.max(1, width));

  const subtitleRow = sheet.addRow([report.subtitle]);
  subtitleRow.font = { size: 10, color: { argb: MUTED } };
  sheet.mergeCells(2, 1, 2, Math.max(1, width));

  const header = sheet.addRow(report.columns.map((c) => c.label));
  header.eachCell((cell, i) => {
    cell.font = { bold: true, size: 10, color: { argb: MUTED } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } };
    cell.border = { bottom: { style: 'thin', color: { argb: RULE } } };
    cell.alignment = { horizontal: isNumeric(report.columns[i - 1].type) ? 'right' : 'left' };
  });

  for (const row of report.rows) {
    const values = report.columns.map((c) => {
      const v = row[c.key];
      // Numeric columns are written as numbers, not text, so the recipient can
      // total a column without cleaning it first.
      if (isNumeric(c.type)) return Number(v) || 0;
      return v == null ? '' : String(v);
    });

    const added = sheet.addRow(values);
    added.eachCell((cell, i) => {
      const type = report.columns[i - 1].type;
      if (isNumeric(type)) {
        cell.numFmt = NUMBER_FORMAT[type];
        cell.alignment = { horizontal: 'right' };
      }
      if (type === 'code') cell.font = { name: 'Consolas', size: 10 };
    });
  }

  if (report.totals && Object.keys(report.totals).length) {
    sheet.addRow([]);
    const [key, value] = Object.entries(report.totals)[0];
    const label = key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1');
    const totalRow = sheet.addRow([...Array(Math.max(0, width - 2)).fill(''), label, Number(value) || 0]);
    totalRow.font = { bold: true, color: { argb: INK } };
    totalRow.getCell(Math.max(1, width)).numFmt = NUMBER_FORMAT.money;
  }

  // Size each column to its widest cell, within sane bounds.
  sheet.columns.forEach((column, i) => {
    const label = report.columns[i]?.label ?? '';
    let widest = label.length;
    column.eachCell({ includeEmpty: false }, (cell) => {
      const length = String(cell.value ?? '').length;
      if (length > widest) widest = length;
    });
    column.width = Math.min(46, Math.max(10, widest + 3));
  });

  return workbook.xlsx.writeBuffer();
}

/* --------------------------------------------------------------------- pdf */

/**
 * Build a PDF.
 *
 * Landscape, because these reports are wide. Columns are laid out
 * proportionally to their content, and the header repeats on every page so a
 * printed page is readable on its own.
 *
 * @returns {Promise<Buffer>}
 */
export function buildPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });

    // Register the operator's font once, then refer to it by name.
    const REGULAR = hasEmbeddedFont ? 'body' : 'Helvetica';
    const BOLD = hasEmbeddedFont ? 'body' : 'Helvetica-Bold';
    if (hasEmbeddedFont) doc.registerFont('body', PDF_FONT_PATH);

    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // Give numeric columns a narrower share; text needs the room.
    const weights = report.columns.map((c) => (isNumeric(c.type) ? 1 : 1.6));
    const totalWeight = weights.reduce((t, w) => t + w, 0);
    const widths = weights.map((w) => (w / totalWeight) * usable);

    const drawHeader = () => {
      doc.font(BOLD).fontSize(14).fillColor('#1A1817').text(pdfSafe(report.title), left, 36);
      doc.font(REGULAR).fontSize(9).fillColor('#6E6A64').text(pdfSafe(report.subtitle));
      doc.moveDown(0.6);

      const y = doc.y;
      doc.font(BOLD).fontSize(8).fillColor('#6E6A64');
      let x = left;
      report.columns.forEach((c, i) => {
        doc.text(pdfSafe(c.label.toUpperCase()), x + 2, y, {
          width: widths[i] - 4,
          align: isNumeric(c.type) ? 'right' : 'left',
        });
        x += widths[i];
      });

      const ruleY = y + 12;
      doc.moveTo(left, ruleY).lineTo(left + usable, ruleY).lineWidth(0.5).strokeColor('#E3E0DA').stroke();
      doc.y = ruleY + 5;
    };

    drawHeader();

    doc.font(REGULAR).fontSize(8).fillColor('#1A1817');
    const bottom = doc.page.height - doc.page.margins.bottom - 30;

    for (const row of report.rows) {
      if (doc.y > bottom) {
        doc.addPage();
        drawHeader();
        doc.font(REGULAR).fontSize(8).fillColor('#1A1817');
      }

      const y = doc.y;
      let x = left;
      report.columns.forEach((c, i) => {
        const raw = row[c.key];
        let text;
        if (c.type === 'money') text = formatMoney(raw);
        else if (c.type === 'number') text = formatNumber(raw);
        else if (c.type === 'percent') text = `${(Number(raw) || 0).toFixed(1)}%`;
        else text = raw == null || raw === '' ? '—' : String(raw);

        // A negative figure reads red, as it does on screen.
        doc.fillColor(c.type === 'money' && Number(raw) < 0 ? '#B3261E' : '#1A1817');
        doc.text(pdfSafe(text), x + 2, y, {
          width: widths[i] - 4,
          align: isNumeric(c.type) ? 'right' : 'left',
          lineBreak: false,
          ellipsis: true,
        });
        x += widths[i];
      });

      doc.y = y + 13;
    }

    if (report.totals && Object.keys(report.totals).length) {
      const [key, value] = Object.entries(report.totals)[0];
      const label = key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1');
      doc.moveTo(left, doc.y).lineTo(left + usable, doc.y).strokeColor('#E3E0DA').stroke();
      doc.moveDown(0.4);
      doc
        .font(BOLD)
        .fontSize(9)
        .fillColor(ACCENT.replace('FF', '#'))
        .text(pdfSafe(`${label}: ${formatMoney(value)}`), left, doc.y, { width: usable, align: 'right' });
    }

    doc
      .font(REGULAR)
      .fontSize(7)
      .fillColor('#8C877F')
      .text(
        `${report.rows.length} rows · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
        left,
        doc.page.height - doc.page.margins.bottom - 12,
        { width: usable, align: 'left' }
      );

    doc.end();
  });
}

/** Taka with lakh/crore grouping, matching the on-screen format. */
function formatMoney(value) {
  const n = Math.round(Number(value) || 0);
  return `${n < 0 ? '-' : ''}Tk ${Math.abs(n).toLocaleString('en-IN')}`;
}

function formatNumber(value) {
  return (Number(value) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
}
