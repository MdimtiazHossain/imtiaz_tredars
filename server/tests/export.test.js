import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { config } from '../src/lib/config.js';
import * as fontkit from 'fontkit';
import { buildPdf } from '../src/lib/export.js';

/**
 * PDF exports and non-Latin text.
 *
 * PDFKit's built-in fonts encode Latin-1 only, so without an embedded font a
 * Bengali crop or party name exports as a row of "?". These tests cover the
 * font actually configured for this environment, so a deployment that forgets
 * PDF_FONT_PATH is told what it loses rather than discovering it in a report.
 */

const FONT = config.pdfFontPath;
const hasFont = Boolean(FONT && fs.existsSync(FONT));

// Conjuncts are the hard part of Bengali: each of these needs the font's
// substitution tables, not just a glyph per code point.
const SAMPLES = [
  'ধান (ব্রি-২৮)',
  'মেসার্স করিম ট্রেডার্স',
  'নওগাঁ সেন্ট্রাল গোডাউন',
  'ব্যাচ-ভিত্তিক ফসল মুনাফা',
];

const report = {
  title: SAMPLES[3],
  subtitle: SAMPLES[2],
  columns: [
    { key: 'batch', label: 'Batch', type: 'text' },
    { key: 'party', label: 'ফসল', type: 'text' },
    { key: 'value', label: 'মূল্য', type: 'money' },
  ],
  rows: [{ batch: 'BC-2607-001', party: SAMPLES[1], value: 180266 }],
  totals: { value: 180266 },
};

describe('pdf export', () => {
  it('builds a pdf without throwing on Bengali text', async () => {
    const pdf = await buildPdf(report);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it.runIf(hasFont)('embeds the configured font rather than substituting "?"', async () => {
    const pdf = await buildPdf(report);
    // A subset of an embedded TrueType font is written as a FontFile2 stream;
    // one of the built-in Latin-1 faces would produce no such stream.
    expect(pdf.toString('latin1')).toContain('FontFile2');
  });

  it.runIf(hasFont)('uses a font that covers Bengali, including conjuncts', () => {
    const open = fontkit.openSync || fontkit.default?.openSync;
    const font = open(FONT);

    for (const sample of SAMPLES) {
      const run = font.layout(sample);
      const missing = run.glyphs.filter((g) => g.id === 0);
      expect(missing, `${font.familyName} has no glyph for part of "${sample}"`).toEqual([]);
      // Shaping collapses a consonant cluster into one glyph, so a correctly
      // shaped run is shorter than the text. Equal length would mean the
      // conjuncts had been rendered as separate letters with visible hasanta.
      expect(run.glyphs.length, `"${sample}" was not shaped`).toBeLessThan([...sample].length);
    }
  });

  it.runIf(hasFont)('covers the taka sign, which the money format depends on', () => {
    const open = fontkit.openSync || fontkit.default?.openSync;
    const font = open(FONT);
    // U+09F3. Without it every money column would export as "?".
    expect(font.layout('৳').glyphs.some((g) => g.id === 0)).toBe(false);
  });
});
