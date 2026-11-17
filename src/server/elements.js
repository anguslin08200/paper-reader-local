import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Figures, tables, algorithms and equations extracted by MinerU (parsed/middle_json.json).
// Each element carries its page, normalized bbox and exact source text so the assistant can
// explain it from the original content instead of a low-resolution screenshot.

const KIND_BY_TYPE = { image: 'figure', chart: 'figure', table: 'table', code: 'algorithm', equation: 'equation' };
const KIND_ORDER = { figure: 0, table: 1, algorithm: 2, equation: 3 };
export const ELEMENT_IMAGE_PATTERN = /^images\/[A-Za-z0-9._-]+\.(?:jpe?g|png|webp)$/;

// Flatten MinerU inline content (text, inline/display equations, nested spans) into Markdown-ish text.
export function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    if (!item || typeof item !== 'object') return '';
    if (item.type === 'equation_inline') return `$${item.content}$`;
    if (item.type === 'equation' || item.type === 'interline_equation') return `$$${item.content}$$`;
    return flattenContent(item.content);
  }).join('');
}

function cjkRatio(text) {
  const chars = [...String(text)].filter((char) => /[\p{L}\p{N}]/u.test(char));
  return chars.length ? chars.filter((char) => /\p{Script=Han}/u.test(char)).length / chars.length : 0;
}

function captionLabel(kind, caption, page) {
  // Prefer the paper's own label such as "Figure 3" / "TABLE II" / "Algorithm 1", wherever it appears.
  const match = /((?:Figure|Fig\.|Table|Algorithm)\s*(?:\d+[a-z]?|[IVXLC]+\b)|(?:圖|表|演算法)\s*\d+)/i.exec(caption);
  if (match) return match[1].replace(/^Fig\.\s*/i, 'Figure ').replace(/^TABLE/, 'Table');
  return `第 ${page} 頁${{ figure: '圖片', table: '表格', algorithm: '演算法', equation: '公式' }[kind]}`;
}

// Tiny images (logos, icons, badges) are not useful explanation targets.
const MIN_FIGURE_AREA = 0.004;
const area = (bbox) => (bbox ? Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]) : 1);

export function extractElements(middle) {
  return sortElements(dedupeTranslatedCopies(extractAllElements(middle)));
}

function sortElements(elements) {
  return elements.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.page - b.page || (a.bbox?.[1] ?? 0) - (b.bbox?.[1] ?? 0));
}

// Every parsed element including translated copies (used for click targets on both halves).
export function extractAllElements(middle) {
  const pages = Array.isArray(middle?.pages) ? middle.pages : [];
  const elements = [];
  for (const page of pages) {
    const pageNumber = Number(page.page_idx) + 1;
    for (const block of page.blocks || []) {
      const kind = KIND_BY_TYPE[block.type];
      if (!kind) continue;
      const parts = Array.isArray(block.content) ? block.content : [];
      const body = parts.find((part) => /_body$/.test(part?.type)) || block;
      const caption = parts.filter((part) => /_caption$/.test(part?.type)).map((part) => flattenContent(part.content)).join(' ').trim();
      const footnote = parts.filter((part) => /_footnote$/.test(part?.type)).map((part) => flattenContent(part.content)).join(' ').trim();
      let text = kind === 'equation' ? `$$${block.content}$$` : flattenContent(body.content).trim();
      if (kind === 'table' && footnote) text = `${text}\n${footnote}`;
      const image = body.image_path || block.image_path || null;
      const bbox = Array.isArray(block.bbox) ? block.bbox.map(Number) : null;
      if (kind === 'figure' && (!image || area(bbox) < MIN_FIGURE_AREA)) continue;
      // Algorithms carry their title in the first line instead of a caption block.
      const titleSource = caption || (kind === 'algorithm' ? text.split('\n')[0] : '');
      elements.push({
        id: `p${pageNumber}-${block.index ?? elements.length}`,
        kind,
        page: pageNumber,
        bbox,
        image: image && ELEMENT_IMAGE_PATTERN.test(image) ? image : null,
        label: captionLabel(kind, titleSource, pageNumber),
        caption,
        text: text.slice(0, 12000),
        lang: cjkRatio(`${caption} ${kind === 'equation' ? '' : text}`) > 0.3 ? 'zh' : 'en',
      });
    }
  }
  return elements;
}

// Click targets for every element copy. A translated copy (right half of a side-by-side page)
// points at its English twin so both sides attach the same original source.
export function buildHotspots(all, kept) {
  const keptIds = new Set(kept.map((item) => item.id));
  return all.filter((item) => item.bbox).map((item) => {
    if (keptIds.has(item.id)) return { id: item.id, page: item.page, bbox: item.bbox, kind: item.kind, targetId: item.id, mirrored: false };
    let best = null;
    for (const twin of kept) {
      if (twin.page !== item.page || twin.kind !== item.kind || !twin.bbox) continue;
      if (item.kind === 'equation' && twin.text === item.text) { best = { twin, distance: 0 }; break; }
      // Mirror across the page midline: right-half x is about left-half x + 0.5.
      const shift = item.bbox[0] >= 0.48 ? -0.5 : 0.5;
      const distance = Math.abs(item.bbox[0] + shift - twin.bbox[0]) + Math.abs(item.bbox[1] - twin.bbox[1]);
      if (distance < 0.15 && (!best || distance < best.distance)) best = { twin, distance };
    }
    return best ? { id: item.id, page: item.page, bbox: item.bbox, kind: item.kind, targetId: best.twin.id, mirrored: true, localCaption: item.caption } : null;
  }).filter(Boolean);
}

const TEXT_TYPES = new Set(['text', 'paragraph_title', 'ref_text', 'doc_title', 'page_footnote']);

// Paragraph-level text blocks per page for left/right counterpart lookup.
export function extractTextBlocks(middle) {
  const pages = Array.isArray(middle?.pages) ? middle.pages : [];
  const result = new Map();
  for (const page of pages) {
    const blocks = (page.blocks || []).filter((block) => TEXT_TYPES.has(block.type) && Array.isArray(block.bbox))
      .map((block) => ({ bbox: block.bbox.map(Number), text: flattenContent(block.content).trim() }))
      .filter((block) => block.text);
    result.set(Number(page.page_idx) + 1, blocks);
  }
  return result;
}

const half = (bbox) => (bbox[0] >= 0.48 ? 'right' : bbox[2] <= 0.52 ? 'left' : 'both');
// Reading order inside one half: column (left/right part of that half), then top-to-bottom.
function readingOrder(blocks, side) {
  const middle = side === 'right' ? 0.75 : 0.25;
  return blocks.filter((block) => half(block.bbox) === side)
    .sort((a, b) => (a.bbox[0] >= middle) - (b.bbox[0] >= middle) || a.bbox[1] - b.bbox[1]);
}

const overlaps = (a, b, shift = 0) => Math.min(a[2], b[2] + shift) - Math.max(a[0], b[0] + shift) > 0 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 0;

// For a selection on one half of a side-by-side page, return the matching paragraphs from the
// other half (Chinese selection gives the English original; English selection gives the translation).
export function findCounterpart(textBlocks, pageNumber, rect) {
  const blocks = textBlocks.get(pageNumber) || [];
  const side = rect.x + rect.w / 2 >= 0.5 ? 'right' : 'left';
  const mine = readingOrder(blocks, side);
  const theirs = readingOrder(blocks, side === 'right' ? 'left' : 'right');
  if (!mine.length || !theirs.length) return null;
  const box = [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h];
  const hits = mine.map((block, index) => ({ block, index })).filter(({ block }) => overlaps(block.bbox, box));
  if (!hits.length) return null;
  const shift = side === 'right' ? -0.5 : 0.5;
  // Same paragraph count on both halves: pair by reading-order index (robust to reflowed heights);
  // otherwise mirror each selected paragraph across the midline and take overlapping ones.
  const matched = mine.length === theirs.length
    ? hits.map(({ index }) => theirs[index])
    : theirs.filter((block) => hits.some(({ block: own }) => overlaps(block.bbox, own.bbox, shift)));
  const text = [...new Set(matched.filter(Boolean))].map((block) => block.text).join('\n\n');
  if (!text) return null;
  return { side, otherLang: cjkRatio(text) > 0.3 ? 'zh' : 'en', text: text.slice(0, 8000) };
}

// Bilingual PDFs contain each element twice (English and translated); keep the English copy.
export function dedupeTranslatedCopies(elements) {
  // Side-by-side bilingual pages: English on the left half, translation on the right half.
  const sideBySidePages = new Set();
  for (const item of elements) {
    if (item.lang !== 'zh' || !item.bbox || item.bbox[0] < 0.48) continue;
    if (elements.some((other) => other.page === item.page && other.lang === 'en' && other.bbox && other.bbox[2] <= 0.52)) sideBySidePages.add(item.page);
  }
  elements = elements.filter((item) => !(sideBySidePages.has(item.page) && item.bbox && item.bbox[0] >= 0.48));
  const englishKeys = new Set(elements.filter((item) => item.lang === 'en').map((item) => `${item.page}:${item.kind}`));
  const englishEquations = new Set(elements.filter((item) => item.kind === 'equation').map((item) => `${item.page}:${item.text}`));
  const seenEquation = new Set();
  return elements.filter((item) => {
    if (item.kind === 'equation') {
      // Identical LaTeX on the same page is the translated copy of the same equation.
      const key = `${item.page}:${item.text}`;
      if (seenEquation.has(key)) return false;
      seenEquation.add(key);
      return englishEquations.has(key);
    }
    return item.lang === 'en' || !englishKeys.has(`${item.page}:${item.kind}`);
  });
}

async function readMiddle(paperDirectory) {
  try {
    return JSON.parse(await readFile(path.join(paperDirectory, 'parsed', 'middle_json.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function listPaperElements(paperDirectory) {
  const middle = await readMiddle(paperDirectory);
  return middle ? extractElements(middle) : [];
}

// Elements for the list plus click targets for both halves of bilingual pages.
export async function loadPaperLayout(paperDirectory) {
  const middle = await readMiddle(paperDirectory);
  if (!middle) return { elements: [], hotspots: [] };
  const all = extractAllElements(middle);
  const elements = sortElements(dedupeTranslatedCopies([...all]));
  return { elements, hotspots: buildHotspots(all, elements) };
}

export async function paperCounterpart(paperDirectory, pageNumber, rect) {
  const middle = await readMiddle(paperDirectory);
  return middle ? findCounterpart(extractTextBlocks(middle), pageNumber, rect) : null;
}

// Paragraph blocks of the parsed (single-language) page that overlap a rectangle. Used for
// translation-generated side-by-side PDFs, whose left half is the parsed original page.
export function findBlocks(textBlocks, pageNumber, rect) {
  const box = [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h];
  return (textBlocks.get(pageNumber) || []).filter((block) => overlaps(block.bbox, box)).map(({ bbox, text }) => ({ bbox, text: text.slice(0, 4000) }));
}

export async function paperBlocks(paperDirectory, pageNumber, rect) {
  const middle = await readMiddle(paperDirectory);
  return middle ? findBlocks(extractTextBlocks(middle), pageNumber, rect) : [];
}

// Resolve an element image strictly inside parsed/images; callers pass only the relative name.
export function elementImagePath(paperDirectory, relative) {
  if (typeof relative !== 'string' || !ELEMENT_IMAGE_PATTERN.test(relative)) return null;
  const root = path.join(paperDirectory, 'parsed');
  const target = path.resolve(root, relative);
  return target.startsWith(`${path.join(root, 'images')}${path.sep}`) ? target : null;
}
