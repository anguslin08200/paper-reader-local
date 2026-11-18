import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Count Han characters against letters and numbers; punctuation does not dilute the Chinese signal.
export const CJK_RATIO_THRESHOLD = 0.2;
export function detectTextSource(fileName, text = '') {
  const name = String(fileName || '');
  const bilingual = /dual|雙語|双语/i.test(name);
  const chinese = /mono|pureChinese|\u7d14\u4e2d\u6587|\u7eaf\u4e2d\u6587/i.test(name);
  const named = /_\u7ffb\u8b6f|\.zh-TW\.(?:dual|mono)|dual|mono|pureChinese|\u96d9\u8a9e|\u53cc\u8bed|\u7d14\u4e2d\u6587|\u7eaf\u4e2d\u6587/i.test(name);
  const chars = [...text].filter((char) => /[\p{L}\p{N}]/u.test(char));
  const cjkRatio = chars.length ? chars.filter((char) => /\p{Script=Han}/u.test(char)).length / chars.length : 0;
  const sourceKind = named || cjkRatio > CJK_RATIO_THRESHOLD ? 'translated' : 'original';
  return { sourceKind, translatedVariant: chinese && !bilingual ? 'chinese' : 'bilingual', reason: named ? 'filename' : sourceKind === 'translated' ? 'text' : 'default', cjkRatio };
}

export async function detectPdfSource(fileName, buffer) {
  // Limit local PDF text extraction to two pages and never resolve external resources.
  let text = '';
  let doc;
  try {
    doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true, isEvalSupported: false }).promise;
    for (let pageNumber = 1; pageNumber <= Math.min(2, doc.numPages); pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      text += content.items.map((item) => item.str || '').join(' ');
      page.cleanup();
    }
  } catch { /* Filename detection still works for scanned or unreadable documents. */ }
  finally { await doc?.destroy(); }
  return detectTextSource(fileName, text);
}

export function sourceSelection(body, detected) {
  const sourceKind = body.sourceKind ?? detected.sourceKind;
  if (!['original', 'translated'].includes(sourceKind)) throw new Error('Invalid source kind');
  const translatedVariant = body.translatedVariant ?? detected.translatedVariant ?? 'bilingual';
  if (!['bilingual', 'chinese'].includes(translatedVariant)) throw new Error('Invalid translated variant');
  return { sourceKind, translatedVariant };
}

export async function startImportTranslation(paper, autoTranslate, start, settings) {
  // Imported translations must never be submitted for another PDF translation.
  if (autoTranslate && paper.sourceKind === 'original') return start(paper.id, settings);
}
