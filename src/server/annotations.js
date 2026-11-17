import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PDFDocument, PDFName, PDFString, PDFHexString } from 'pdf-lib';
import { ANNOTATION_FONTS, createAnnotationFontResolver } from './annotation-fonts.js';

// Highlights and text boxes per paper, stored next to the paper (annotations.json).
// Coordinates are normalized to the displayed page; legacy records imply type: highlight.

export const HIGHLIGHT_COLORS = {
  yellow: [1, 0.92, 0.23],
  green: [0.55, 0.9, 0.45],
  pink: [1, 0.6, 0.78],
  blue: [0.55, 0.78, 1],
};
const VARIANTS = new Set(['original', 'chinese', 'bilingual']);
const filePath = (directory) => path.join(directory, 'annotations.json');
const locks = new Map();

export async function readAnnotations(directory) {
  try {
    const data = JSON.parse(await readFile(filePath(directory), 'utf8'));
    return Array.isArray(data.annotations) ? data.annotations : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// Serialized read-modify-write with atomic replace, so concurrent edits never lose highlights.
export async function mutateAnnotations(directory, mutate) {
  const previous = locks.get(directory) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  // Keep the exact queued promise so the final writer can release the lock entry.
  const queued = previous.then(() => current);
  locks.set(directory, queued);
  await previous;
  try {
    const annotations = await readAnnotations(directory);
    const result = await mutate(annotations);
    const temporary = `${filePath(directory)}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ annotations }, null, 2));
    await rename(temporary, filePath(directory));
    return result;
  } finally {
    release();
    if (locks.get(directory) === queued) locks.delete(directory);
  }
}

const clamp = (value) => Math.min(1, Math.max(0, Number(value)));

// Validate client input: bounded rect count, normalized coordinates, known color/variant.
export function sanitizeAnnotation(input = {}, existing = {}) {
  // Legacy records did not have a type; retaining that meaning keeps old highlights editable.
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('註記資料無效');
  const type = input.type ?? existing.type ?? 'highlight';
  if (!['highlight', 'text'].includes(type)) throw new Error('註記類型無效');
  const variant = input.variant ?? existing.variant ?? 'original';
  if (!VARIANTS.has(variant)) throw new Error('PDF 版本無效');
  const page = Math.max(1, Math.floor(Number(input.page ?? existing.page) || 1));
  if (type === 'text') {
    const value = (key, fallback) => input[key] ?? existing[key] ?? fallback;
    const rect = Object.fromEntries(['x', 'y', 'w', 'h'].map((key) => [key, value(key)]));
    if (Object.values(rect).some((number) => typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1) || rect.w <= 0 || rect.h <= 0 || rect.x + rect.w > 1.000001 || rect.y + rect.h > 1.000001) throw new Error('文字方塊範圍無效');
    if (typeof value('page', 1) !== 'number' || !Number.isSafeInteger(value('page', 1)) || value('page', 1) < 1) throw new Error('PDF 頁碼無效');
    const color = value('color', '#000000');
    const font = value('font', 'Microsoft JhengHei');
    const size = value('size', 16);
    const bold = value('bold', false); const italic = value('italic', false);
    const background = value('background', 'none'); const text = value('text', '');
    if (typeof color !== 'string' || !/^#[a-f\d]{6}$/i.test(color)) throw new Error('文字顏色無效');
    if (typeof font !== 'string' || !Object.hasOwn(ANNOTATION_FONTS, font)) throw new Error('文字字型無效');
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 8 || size > 48) throw new Error('文字大小必須介於 8 到 48 PDF pt');
    if (typeof bold !== 'boolean' || typeof italic !== 'boolean') throw new Error('文字樣式無效');
    if (!['none', 'yellow'].includes(background)) throw new Error('文字背景無效');
    if (typeof text !== 'string' || text.length > 5000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error('文字內容無效');
    return { type, page, variant, ...rect, text: text.replace(/\r\n?/g, '\n').replace(/\t/g, '    '), color: color.toLowerCase(), font, size, bold, italic, background };
  }
  const rects = Array.isArray(input.rects) ? input.rects : existing.rects;
  if (!Array.isArray(rects) || !rects.length || rects.length > 200) throw new Error('螢光筆範圍無效');
  const cleanRects = rects.map((rect) => {
    const values = ['x', 'y', 'w', 'h'].map((key) => Number(rect?.[key]));
    if (!values.every(Number.isFinite)) throw new Error('螢光筆範圍無效');
    const [x, y, w, h] = values;
    return { x: clamp(x), y: clamp(y), w: clamp(w), h: clamp(h) };
  });
  const color = input.color ?? existing.color ?? 'yellow';
  if (typeof color !== 'string' || !Object.hasOwn(HIGHLIGHT_COLORS, color)) throw new Error('不支援的螢光筆顏色');
  return {
    type, page, variant, rects: cleanRects, color,
    text: String(input.text ?? existing.text ?? '').slice(0, 5000),
    note: String(input.note ?? existing.note ?? '').slice(0, 20000),
  };
}

// Write highlights (with their notes as pop-up contents) into a copy of the PDF as standard
// /Highlight annotations, so Adobe Acrobat and other readers show and edit them natively.
export async function exportAnnotatedPdf(pdfBytes, annotations, { title = 'Paper Reader' } = {}) {
  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = pdf.getPages();
  const warnings = new Set();
  let resolveFonts;
  let written = 0;
  for (const annotation of annotations) {
    const page = pages[annotation.page - 1];
    if (!page) continue;
    // Normalized coordinates refer to the rendered (crop box, rotation-applied) page.
    const box = page.getCropBox();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const toPdf = (nx, ny) => {
      // Map viewer coordinates (origin top-left of the rotated view) back to PDF user space.
      const { x, y, width, height } = box;
      if (rotation === 90) return [x + ny * width, y + nx * height];
      if (rotation === 180) return [x + (1 - nx) * width, y + ny * height];
      if (rotation === 270) return [x + (1 - ny) * width, y + (1 - nx) * height];
      return [x + nx * width, y + (1 - ny) * height];
    };
    if (annotation.type === 'text') {
      // Fontkit is loaded only for text exports so existing highlight exports stay usable offline.
      resolveFonts ||= await createAnnotationFontResolver(pdf, warnings);
      await writeFreeText(pdf, page, sanitizeAnnotation(annotation), annotation, toPdf, rotation, resolveFonts, title);
      written += 1;
      continue;
    }
    const quads = [];
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const rect of annotation.rects) {
      // QuadPoints order per PDF spec practice: top-left, top-right, bottom-left, bottom-right.
      const corners = [toPdf(rect.x, rect.y), toPdf(rect.x + rect.w, rect.y), toPdf(rect.x, rect.y + rect.h), toPdf(rect.x + rect.w, rect.y + rect.h)];
      for (const [px, py] of corners) {
        quads.push(px, py);
        minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
      }
    }
    const context = pdf.context;
    const highlight = context.obj({
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: [minX, minY, maxX, maxY],
      QuadPoints: quads,
      C: HIGHLIGHT_COLORS[annotation.color] || HIGHLIGHT_COLORS.yellow,
      CA: 0.45,
      F: 4,
      T: PDFHexString.fromText(title),
      Contents: PDFHexString.fromText(annotation.note || ''),
      NM: PDFString.of(annotation.id),
      M: PDFString.of(toPdfDate(annotation.updatedAt || annotation.createdAt)),
    });
    // Appearance stream (translucent multiply fill per line) so Chrome/Edge/pdf.js also show the
    // highlight; Acrobat would synthesize one, other viewers do not.
    const [red, green, blue] = HIGHLIGHT_COLORS[annotation.color] || HIGHLIGHT_COLORS.yellow;
    const fills = [];
    for (let index = 0; index < quads.length; index += 8) {
      const xs = [quads[index], quads[index + 2], quads[index + 4], quads[index + 6]];
      const ys = [quads[index + 1], quads[index + 3], quads[index + 5], quads[index + 7]];
      const left = Math.min(...xs) - minX; const bottom = Math.min(...ys) - minY;
      fills.push(`${left.toFixed(3)} ${bottom.toFixed(3)} ${(Math.max(...xs) - Math.min(...xs)).toFixed(3)} ${(Math.max(...ys) - Math.min(...ys)).toFixed(3)} re f`);
    }
    const appearance = context.stream(`/GS0 gs ${red} ${green} ${blue} rg\n${fills.join('\n')}`, {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, maxX - minX, maxY - minY], Matrix: [1, 0, 0, 1, 0, 0],
      Resources: { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', CA: 0.45, ca: 0.45 } } },
    });
    highlight.set(PDFName.of('AP'), context.obj({ N: context.register(appearance) }));
    const highlightRef = context.register(highlight);
    const annots = page.node.lookup(PDFName.of('Annots'));
    const refs = [highlightRef];
    if (annotation.note) {
      // A closed pop-up shows the note when the highlight is clicked in Acrobat.
      const popup = context.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [maxX, maxY - 120, maxX + 220, maxY], Parent: highlightRef, Open: false });
      const popupRef = context.register(popup);
      highlight.set(PDFName.of('Popup'), popupRef);
      refs.push(popupRef);
    }
    if (annots) for (const ref of refs) annots.push(ref);
    else page.node.set(PDFName.of('Annots'), context.obj(refs));
    written += 1;
  }
  return { bytes: await pdf.save(), written, warnings: [...warnings] };
}

// Escape rich-text XML while keeping /Contents a separate, plain Unicode string.
const escapeXml = (text) => text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));

async function writeFreeText(pdf, page, annotation, original, toPdf, rotation, resolveFonts, title) {
  const context = pdf.context;
  const { x, y, w, h, size } = annotation;
  const corners = [toPdf(x, y), toPdf(x + w, y), toPdf(x, y + h), toPdf(x + w, y + h)];
  const minX = Math.min(...corners.map((point) => point[0])); const minY = Math.min(...corners.map((point) => point[1]));
  const maxX = Math.max(...corners.map((point) => point[0])); const maxY = Math.max(...corners.map((point) => point[1]));
  const box = page.getCropBox();
  const width = w * (rotation % 180 ? box.height : box.width);
  const height = h * (rotation % 180 ? box.width : box.height);
  const rgb = [1, 3, 5].map((index) => Number.parseInt(annotation.color.slice(index, index + 2), 16) / 255);
  const glyphs = await resolveFonts(annotation.text || ' ', annotation);
  // Even an all-newline note needs a DA font resource for PDF editors.
  if (!glyphs.some((glyph) => glyph.font)) glyphs.push(...await resolveFonts(' ', annotation));
  const resources = {}; const operators = ['q', `0 0 ${width} ${height} re W n`];
  if (annotation.background === 'yellow') operators.push(`1 0.96 0.55 rg 0 0 ${width} ${height} re f`);
  operators.push(`${rgb.join(' ')} rg`, `${rgb.join(' ')} RG`);
  let left = 2; let baseline = height - size - 2;
  const lineHeight = size * 1.25;
  for (const glyph of glyphs) {
    if (glyph.character === '\n') { left = 2; baseline -= lineHeight; continue; }
    const advance = glyph.font.widthOfTextAtSize(glyph.character, size);
    if (left > 2 && left + advance > width - 2) { left = 2; baseline -= lineHeight; }
    resources[glyph.resource] = glyph.font.ref;
    // Synthetic style covers CJK families with no installed italic/bold face.
    operators.push(`BT /${glyph.resource} ${size} Tf ${glyph.syntheticBold ? '2 Tr 0.3 w' : '0 Tr'} 1 0 ${glyph.syntheticItalic ? '0.21256' : '0'} 1 ${left} ${baseline} Tm ${glyph.font.encodeText(glyph.character)} Tj ET`);
    left += advance;
  }
  operators.push('Q');
  const first = glyphs.find((glyph) => glyph.font);
  const matrix = rotation === 90 ? [0, 1, -1, 0, height, 0] : rotation === 180 ? [-1, 0, 0, -1, width, height] : rotation === 270 ? [0, -1, 1, 0, 0, width] : [1, 0, 0, 1, 0, 0];
  const appearance = context.stream(operators.join('\n'), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height], Matrix: matrix, Resources: { Font: resources } });
  // DA font resources are also on the page for editors that regenerate appearances.
  for (const [name, ref] of Object.entries(resources)) page.node.setFontDictionary(PDFName.of(name), ref);
  const css = `font-family:${annotation.font};font-size:${size}pt;color:${annotation.color};font-weight:${annotation.bold ? 'bold' : 'normal'};font-style:${annotation.italic ? 'italic' : 'normal'};${annotation.background === 'yellow' ? 'background-color:#fff58c;' : ''}`;
  const freeText = context.obj({
    Type: 'Annot', Subtype: 'FreeText', Rect: [minX, minY, maxX, maxY], F: 4,
    T: PDFHexString.fromText(title),
    Contents: PDFHexString.fromText(annotation.text),
    DA: PDFString.of(`/${first.resource} ${size} Tf ${rgb.join(' ')} rg`),
    RC: PDFHexString.fromText(`<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:APIVersion="Acrobat:11.0.0" xfa:spec="2.0.2"><p style="${escapeXml(css)}">${escapeXml(annotation.text).replace(/\n/g, '<br/>')}</p></body>`),
    Q: 0, BS: { W: 0 }, Border: [0, 0, 0],
    DR: { Font: resources }, AP: { N: context.register(appearance) },
    NM: PDFString.of(original.id || randomUUID()), M: PDFString.of(toPdfDate(original.updatedAt || original.createdAt)),
  });
  if (annotation.background === 'yellow') freeText.set(PDFName.of('C'), context.obj([1, 0.96, 0.55]));
  const ref = context.register(freeText);
  const annots = page.node.lookup(PDFName.of('Annots'));
  if (annots) annots.push(ref);
  else page.node.set(PDFName.of('Annots'), context.obj([ref]));
}

function toPdfDate(iso) {
  const date = iso ? new Date(iso) : new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}
