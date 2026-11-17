import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPdfSource, detectTextSource, sourceSelection, startImportTranslation, CJK_RATIO_THRESHOLD } from '../src/server/source-detection.js';
import { createPdfImporter } from '../src/server/import-service.js';

test('detects named translated variants and respects the CJK threshold', () => {
  for (const name of ['paper_翻譯_雙語.pdf', 'paper.zh-TW.dual.pdf', 'paper_dual.pdf', 'paper\u96d9\u8a9e.pdf', 'paper\u53cc\u8bed.pdf']) {
    assert.equal(detectTextSource(name).translatedVariant, 'bilingual');
    assert.equal(detectTextSource(name).sourceKind, 'translated');
  }
  for (const name of ['paper.zh-TW.mono.pdf', 'paper_mono.pdf', 'paper_pureChinese.pdf', 'paper\u7d14\u4e2d\u6587.pdf', 'paper\u7eaf\u4e2d\u6587.pdf']) {
    assert.equal(detectTextSource(name).translatedVariant, 'chinese');
    assert.equal(detectTextSource(name).sourceKind, 'translated');
  }
  assert.equal(detectTextSource('paper_翻譯.pdf').sourceKind, 'translated');
  assert.equal(detectTextSource('paper.pdf', '一abcd').sourceKind, 'original');
  assert.equal(detectTextSource('paper.pdf', '一abcd').cjkRatio, CJK_RATIO_THRESHOLD);
  assert.equal(detectTextSource('paper.pdf', '一二abc').sourceKind, 'translated');
  assert.equal(detectTextSource('paper.pdf', '').cjkRatio, 0);
});

test('source selection validates overrides and auto translation only runs on original PDFs', async () => {
  const detected = detectTextSource('paper_mono.pdf');
  assert.deepEqual(sourceSelection({ sourceKind: 'original' }, detected), { sourceKind: 'original', translatedVariant: 'chinese' });
  assert.throws(() => sourceSelection({ sourceKind: 'bad' }, detected));
  assert.throws(() => sourceSelection({ translatedVariant: 'bad' }, detected));
  const calls = [];
  const start = async (...args) => calls.push(args);
  await startImportTranslation({ id: 'one', sourceKind: 'translated' }, true, start, {});
  await startImportTranslation({ id: 'two', sourceKind: 'original' }, false, start, {});
  await startImportTranslation({ id: 'three', sourceKind: 'original' }, true, start, { flag: true });
  assert.deepEqual(calls, [['three', { flag: true }]]);
});

test('import saves and parses once, starting translation only for an opted-in original', async () => {
  const records = [];
  const parsed = [];
  const translated = [];
  const deps = {
    detectPdfSource: async (name) => detectTextSource(name), sourceSelection,
    createPaperRecord: (metadata) => ({ ...metadata, id: String(records.length) }),
    paperDirectory: (id) => id, paperPdfPath: (id) => `${id}/original.pdf`,
    mkdir: async () => {}, writeFile: async () => {}, rm: async () => {},
    mutateIndex: async (fn) => fn({ papers: records }),
    startParseJob: async (id) => parsed.push(id),
    startPdfTranslation: async (id) => translated.push(id), getAppSettings: async () => ({}),
  };
  const run = createPdfImporter(deps);
  const pdfBuffer = Buffer.from('%PDF-1.4');
  await run({ pdfBuffer, metadata: { fileName: 'original.pdf' }, body: { autoTranslate: true } });
  await run({ pdfBuffer, metadata: { fileName: 'paper雙語.pdf' }, body: { autoTranslate: true } });
  await run({ pdfBuffer, metadata: { fileName: 'original.pdf' }, body: { autoTranslate: false } });
  assert.equal(records.length, 3);
  assert.deepEqual(parsed, ['0', '1', '2']);
  assert.deepEqual(translated, ['0']);
});

// A tiny real PDF maps glyph "a" to Han, with text on three independent pages.
function threePagePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
    ...[7, 8, 9].map((content) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 6 0 R >> >> /Contents ${content} 0 R >>`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 10 0 R >>',
  ];
  const stream = (content) => `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
  for (const text of ['bbbbbbbb', 'aaaa', 'b'.repeat(200)]) objects.push(stream(`BT /F1 12 Tf 10 300 Td (${text}) Tj ET`));
  objects.push(stream('/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Test def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n2 beginbfchar\n<61> <4E2D>\n<62> <0062>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend'));
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

test('PDF detection extracts both first pages and excludes the third page', async () => {
  const result = await detectPdfSource('paper.pdf', threePagePdf());
  assert.equal(result.sourceKind, 'translated');
  assert.equal(result.reason, 'text');
  assert.equal(result.cjkRatio, 1 / 3);
});
