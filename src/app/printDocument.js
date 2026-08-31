/**
 * The paper the business prints on.
 *
 * An invoice and a statement are the same firm's stationery and have to look
 * it, so the sheet -- the type, the rules, the toolbar that does not print --
 * is described once here and the documents supply only their own content.
 *
 * Each is rendered as a whole HTML document and handed to the browser's own
 * print dialogue. That is deliberate rather than lazy: the browser already has
 * the Bengali fonts installed on the machine, and a party's name in Bangla
 * renders as itself here where a server-side PDF would need a font bundled to
 * match.
 */

/** Escape anything that came out of the database before it becomes markup. */
export function escapeHtml(value) {
  return String(value ?? '')
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&#39;');
}

export const e = escapeHtml;

/** The stylesheet both documents are set in. */
export const PRINT_STYLES = `  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #1A1817; background: #fff;
    font-family: 'Instrument Sans', 'Segoe UI', system-ui, sans-serif;
    font-size: 12px; line-height: 1.45;
  }
  .mono { font-family: 'Roboto Mono', ui-monospace, monospace; }
  .right { text-align: right; }
  .strong { font-weight: 700; }
  .sub { font-size: 10.5px; color: #8C877F; margin-top: 2px; }

  header { display: flex; justify-content: space-between; gap: 24px;
           border-bottom: 2px solid #8A2233; padding-bottom: 12px; }
  .org-name { font-size: 19px; font-weight: 700; letter-spacing: -0.01em; }
  .org-line { font-size: 11px; color: #4A463F; margin-top: 2px; }
  .doc { text-align: right; flex: none; }
  .doc-title { font-size: 15px; font-weight: 700; color: #8A2233; letter-spacing: 0.04em;
               text-transform: uppercase; }
  .doc-no { font-size: 17px; font-weight: 700; margin-top: 2px; }

  .draft { margin-top: 10px; padding: 6px 10px; border: 1px solid #B58900;
           background: #FDF6E3; color: #8A5A00; font-size: 11px; font-weight: 600; }

  .parties { display: flex; gap: 28px; margin: 16px 0 14px; }
  .party { flex: 1; }
  .party h2 { margin: 0 0 5px; font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
              text-transform: uppercase; color: #8C877F; }
  .party .who { font-size: 13.5px; font-weight: 700; }
  .meta { flex: none; min-width: 190px; font-size: 11px; }
  .meta div { display: flex; justify-content: space-between; gap: 14px; padding: 2px 0; }
  .meta .k { color: #8C877F; }
  .meta .v { font-weight: 600; }

  table.goods { width: 100%; border-collapse: collapse; margin-top: 6px; }
  table.goods th { background: #FAF9F7; border-top: 1px solid #E3E0DA;
                   border-bottom: 1px solid #E3E0DA; padding: 7px 8px; text-align: left;
                   font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em;
                   text-transform: uppercase; color: #6E6A64; }
  table.goods td { padding: 8px; border-bottom: 1px solid #F0EEE9; vertical-align: top; }
  table.goods td.num { color: #8C877F; width: 26px; }
  table.goods .name { font-weight: 600; }

  .foot { display: flex; justify-content: space-between; gap: 28px; margin-top: 14px; }
  .terms { font-size: 11px; color: #4A463F; max-width: 300px; }
  table.totals { border-collapse: collapse; min-width: 240px; }
  table.totals td { padding: 4px 0 4px 18px; }
  table.totals tr.net td { border-top: 1px solid #E3E0DA; font-weight: 700; font-size: 13.5px;
                           padding-top: 8px; }
  table.totals tr.due td { border-top: 1px solid #E3E0DA; font-weight: 700; color: #8A2233;
                           padding-top: 8px; }

  .signatures { display: flex; justify-content: space-between; gap: 40px; margin-top: 44px; }
  .sign { flex: 1; border-top: 1px solid #CFC9C0; padding-top: 5px; font-size: 10.5px;
          color: #6E6A64; }
  footer { margin-top: 22px; border-top: 1px solid #F0EEE9; padding-top: 8px;
           font-size: 10px; color: #A39D93; text-align: center; }

  .toolbar { position: fixed; top: 0; left: 0; right: 0; padding: 10px;
             background: #1A1817; text-align: center; }
  .toolbar button { border: 0; border-radius: 6px; padding: 8px 18px; font-size: 13px;
                    font-weight: 600; cursor: pointer; background: #8A2233; color: #fff; }
  .toolbar span { color: #CFC9C0; font-size: 12px; margin-left: 12px; }
  .sheet { padding-top: 52px; }
  /* The toolbar is for the screen; paper gets the document alone. */
  @media print { .toolbar { display: none; } .sheet { padding-top: 0; } }`;

/**
 * Wrap a document's content in the sheet.
 *
 * @param {object} o
 * @param {string} o.title      what the browser tab and the print job are called
 * @param {string} o.action     the toolbar button's label
 * @param {string} o.body       the document itself
 * @param {string} [o.extraCss] rules only this kind of document needs
 */
export function printableDocument({ title, action, body, extraCss = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${e(title)}</title>
<style>
${PRINT_STYLES}
${extraCss}
</style>
</head>
<body>
  <div class="toolbar">
    <button onclick="window.print()">${e(action)}</button>
    <span>or press Ctrl+P</span>
  </div>

  <div class="sheet">
${body}
  </div>
</body>
</html>`;
}

/**
 * Open a document in its own window, ready to print.
 *
 * A window rather than the current page, so the application is still there
 * behind it and nothing about the app's own stylesheet reaches the paper.
 *
 * @returns {boolean} false when the browser blocked the window
 */
export function openPrintable(html, open = (...args) => window.open(...args)) {
  const printer = open('', '_blank', 'noopener,width=900,height=1000');
  if (!printer) return false;

  printer.document.write(html);
  printer.document.close();
  return true;
}
