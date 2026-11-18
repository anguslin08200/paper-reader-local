import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, PDFName, StandardFonts, degrees, decodePDFRawStream } from 'pdf-lib';
import { readAnnotations, mutateAnnotations, sanitizeAnnotation, exportAnnotatedPdf } from '../src/server/annotations.js';

test('sanitize rejects bad input and clamps coordinates', () => {
  assert.throws(() => sanitizeAnnotation({ rects: [] }), /範圍/);
  assert.throws(() => sanitizeAnnotation({ rects: [{ x: 0, y: 0, w: 1, h: 1 }], color: 'purple' }), /顏色/);
  // Object prototype names are never palette entries.
  assert.throws(() => sanitizeAnnotation({ rects: [{ x: 0, y: 0, w: 1, h: 1 }], color: 'toString' }), /顏色/);
  assert.throws(() => sanitizeAnnotation({ rects: [{ x: 0, y: 0, w: 1, h: 1 }], variant: '../x' }), /版本/);
  const clean = sanitizeAnnotation({ page: 2, rects: [{ x: -1, y: 0.5, w: 2, h: 0.1 }], text: 'abc' });
  assert.deepEqual(clean.rects[0], { x: 0, y: 0.5, w: 1, h: 0.1 });
  assert.equal(clean.color, 'yellow');
  assert.equal(clean.type, 'highlight');
});

const textAnnotation = (overrides = {}) => ({ type: 'text', page: 1, x: 0.1, y: 0.2, w: 0.5, h: 0.2, text: '中文 English <&>\n第二行', color: '#123ABC', font: 'Microsoft JhengHei', size: 16, bold: false, italic: false, background: 'none', ...overrides });

test('text annotations preserve styles, normalize line endings, and merge partial edits', () => {
  const clean = sanitizeAnnotation(textAnnotation({ text: '繁體\r\n中文\tABC', bold: true }));
  assert.equal(clean.text, '繁體\n中文    ABC');
  assert.equal(clean.color, '#123abc');
  assert.equal(clean.type, 'text');
  const edited = sanitizeAnnotation({ x: 0.2, background: 'yellow', italic: true }, clean);
  assert.equal(edited.text, clean.text);
  assert.equal(edited.x, 0.2);
  assert.equal(edited.background, 'yellow');
  assert.equal(edited.bold, true);
  assert.equal(edited.italic, true);
});

test('text annotations reject invalid bounds, types, fonts, and style values', () => {
  for (const invalid of [
    { x: -0.1 }, { x: '0.1' }, { x: NaN }, { x: 0.8, w: 0.3 }, { h: 0 }, { h: Infinity },
    { page: '1' }, { page: 1.5 }, { page: -1 }, { color: 'red' }, { color: '#fff' },
    { size: '16' }, { size: 7 }, { size: 49 }, { size: Infinity }, { bold: 1 }, { italic: 'true' },
    { background: 'blue' }, { font: '../../font.ttf' }, { text: 123 }, { text: '\u0000' }, { text: 'a'.repeat(5001) },
  ]) assert.throws(() => sanitizeAnnotation(textAnnotation(invalid)), `accepted ${JSON.stringify(invalid)}`);
  assert.throws(() => sanitizeAnnotation({ type: 'stamp' }));
});

// Only the unavailable optional runtime package may skip the actual font round-trip.
let hasFontkit = true;
try { await import('@pdf-lib/fontkit'); } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  hasFontkit = false;
}

test('missing fontkit gives an actionable error without breaking highlights', { skip: hasFontkit }, async () => {
  const source = await PDFDocument.create(); source.addPage([600, 800]);
  await assert.rejects(exportAnnotatedPdf(await source.save(), [textAnnotation()]), /@pdf-lib\/fontkit.*npm install/);
});

test('FreeText exports Unicode contents, rich text, rotated AP and subset embedded font', { skip: !hasFontkit && '@pdf-lib/fontkit is not installed or cached offline' }, async () => {
  const source = await PDFDocument.create();
  const page = source.addPage([600, 800]);
  page.setCropBox(20, 30, 500, 700); page.setRotation(degrees(90));
  const { bytes, written } = await exportAnnotatedPdf(await source.save(), [textAnnotation({ bold: true, italic: true, background: 'yellow' })]);
  assert.equal(written, 1);
  const reopened = await PDFDocument.load(bytes);
  const annots = reopened.getPages()[0].node.lookup(PDFName.of('Annots'));
  const note = reopened.context.lookup(annots.get(0));
  assert.equal(note.get(PDFName.of('Subtype')).toString(), '/FreeText');
  assert.equal(note.get(PDFName.of('Contents')).decodeText(), '中文 English <&>\n第二行');
  assert.match(note.get(PDFName.of('DA')).decodeText(), /\/PRF\S+ 16 Tf/);
  assert.match(note.get(PDFName.of('RC')).decodeText(), /&lt;&amp;&gt;/);
  assert.match(note.get(PDFName.of('RC')).decodeText(), /font-weight:bold/);
  assert.deepEqual(note.get(PDFName.of('Rect')).asArray().map((value) => value.asNumber()), [120, 100, 220, 450]);
  const appearance = note.lookup(PDFName.of('AP')).lookup(PDFName.of('N'));
  const matrix = appearance.dict.get(PDFName.of('Matrix')).asArray().map((value) => value.asNumber());
  assert.deepEqual(matrix, [0, 1, -1, 0, 100, 0]);
  assert.match(Buffer.from(decodePDFRawStream(appearance).decode()).toString(), / Tf .* Tj ET/);
  const fonts = appearance.dict.lookup(PDFName.of('Resources')).lookup(PDFName.of('Font'));
  for (const [, reference] of fonts.entries()) {
    const font = reopened.context.lookup(reference);
    assert.equal(font.get(PDFName.of('Subtype')).toString(), '/Type0');
    assert.ok(font.get(PDFName.of('ToUnicode')));
    const cidFont = reopened.context.lookup(font.lookup(PDFName.of('DescendantFonts')).get(0));
    const descriptor = cidFont.lookup(PDFName.of('FontDescriptor'));
    assert.ok(descriptor.get(PDFName.of('FontFile2')) || descriptor.get(PDFName.of('FontFile3')));
  }
  // A second save proves the generated objects and references survive editing/reloading.
  assert.ok((await PDFDocument.load(await reopened.save())).getPageCount());
});

test('multiple FreeText fonts reuse document resources without replacing original page fonts', { skip: !hasFontkit && '@pdf-lib/fontkit is not installed or cached offline' }, async () => {
  const source = await PDFDocument.create();
  const page = source.addPage([600, 800]);
  const baseFont = await source.embedFont(StandardFonts.Courier);
  page.node.setFontDictionary(PDFName.of('PRF1'), baseFont.ref);
  const { bytes, written } = await exportAnnotatedPdf(await source.save(), [
    textAnnotation({ id: 'first', text: '第一行', y: 0.1 }),
    textAnnotation({ id: 'latin', text: 'Arial text', y: 0.4, font: 'Arial' }),
    textAnnotation({ id: 'third', text: '第三行', y: 0.7 }),
  ]);
  assert.equal(written, 3);
  const reopened = await PDFDocument.load(bytes);
  const exportedPage = reopened.getPage(0);
  const fonts = exportedPage.node.Resources().lookup(PDFName.of('Font'));
  assert.equal(fonts.lookup(PDFName.of('PRF1')).get(PDFName.of('BaseFont')).toString(), '/Courier');
  const notes = exportedPage.node.lookup(PDFName.of('Annots')).asArray().map((reference) => reopened.context.lookup(reference));
  const firstResource = notes[0].get(PDFName.of('DA')).decodeText().split(' ')[0];
  const latinResource = notes[1].get(PDFName.of('DA')).decodeText().split(' ')[0];
  const thirdResource = notes[2].get(PDFName.of('DA')).decodeText().split(' ')[0];
  assert.equal(firstResource, thirdResource);
  assert.notEqual(firstResource, latinResource);
  assert.notEqual(firstResource, '/PRF1');
  assert.ok(fonts.get(PDFName.of(firstResource.slice(1))));
  assert.ok(fonts.get(PDFName.of(latinResource.slice(1))));
});

test('annotations persist with concurrent writes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'annotations-'));
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) => mutateAnnotations(directory, (list) => list.push({ id: String(index) }))));
    assert.equal((await readAnnotations(directory)).length, 8);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('export writes standard /Highlight annotations with notes as pop-ups', async () => {
  const source = await PDFDocument.create();
  source.addPage([600, 800]);
  source.addPage([600, 800]);
  const annotations = [
    { id: 'a1', page: 1, color: 'yellow', note: '重點：離群值', rects: [{ x: 0.1, y: 0.1, w: 0.5, h: 0.02 }, { x: 0.1, y: 0.125, w: 0.3, h: 0.02 }] },
    { id: 'a2', page: 2, color: 'green', note: '', rects: [{ x: 0.2, y: 0.5, w: 0.2, h: 0.02 }] },
    { id: 'skip', page: 9, color: 'yellow', rects: [{ x: 0, y: 0, w: 0.1, h: 0.1 }] },
  ];
  const { bytes, written } = await exportAnnotatedPdf(await source.save(), annotations);
  assert.equal(written, 2);
  const reopened = await PDFDocument.load(bytes);
  const first = reopened.getPages()[0].node.lookup(PDFName.of('Annots'));
  const subtypes = first.asArray().map((ref) => reopened.context.lookup(ref).get(PDFName.of('Subtype')).toString());
  assert.deepEqual(subtypes, ['/Highlight', '/Popup']);
  const highlight = reopened.context.lookup(first.asArray()[0]);
  // Two rectangles produce two quads (8 numbers each); y is flipped into PDF space (top of page = 800).
  const quads = highlight.get(PDFName.of('QuadPoints')).asArray().map((value) => value.asNumber());
  assert.equal(quads.length, 16);
  assert.ok(Math.abs(quads[1] - 720) < 1e-6);
  assert.match(highlight.get(PDFName.of('Contents')).decodeText(), /離群值/);
  // An appearance stream lets viewers other than Acrobat (Chrome, Edge, pdf.js) draw the mark.
  assert.ok(highlight.get(PDFName.of('AP')));
});
