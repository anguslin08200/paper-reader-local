import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Match the reader's CSS family names; export uses installed fonts, never network fonts.
export const ANNOTATION_FONTS = {
  'Microsoft JhengHei': ['msjh.ttc', 'msjhbd.ttc', 'msjh.ttc', 'msjhbd.ttc'],
  'DFKai-SB': ['kaiu.ttf'],
  PMingLiU: ['mingliu.ttc'],
  'Noto Sans TC': ['NotoSansTC-Regular.ttf', 'NotoSansTC-VF.ttf', 'NotoSansCJKtc-Regular.otf'],
  'Noto Serif TC': ['NotoSerifTC-Regular.ttf', 'NotoSerifTC-VF.ttf', 'NotoSerifCJKtc-Regular.otf'],
  Arial: ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'],
  'Times New Roman': ['times.ttf', 'timesbd.ttf', 'timesi.ttf', 'timesbi.ttf'],
  Georgia: ['georgia.ttf', 'georgiab.ttf', 'georgiai.ttf', 'georgiaz.ttf'],
  Consolas: ['consola.ttf', 'consolab.ttf', 'consolai.ttf', 'consolaz.ttf'],
};

export async function annotationFontkit() {
  try {
    const module = await import('@pdf-lib/fontkit');
    return module.default || module;
  } catch (error) {
    throw new Error('文字 PDF 匯出需要 @pdf-lib/fontkit。請在可連線時執行 npm install，再重新匯出。', { cause: error });
  }
}

// TTC directory offsets are absolute to the collection. Rebuild a standalone SFNT
// before passing it to pdf-lib: a TTC collection itself is not a single font.
export function extractTtcFont(source, index = 0) {
  const bytes = Buffer.from(source);
  if (bytes.toString('ascii', 0, 4) !== 'ttcf') return bytes;
  if (bytes.length < 12 || !Number.isInteger(index) || index < 0 || index >= bytes.readUInt32BE(8)) throw new Error('Invalid TTC font index');
  const position = 12 + index * 4;
  if (position + 4 > bytes.length) throw new Error('Invalid TTC font directory');
  const start = bytes.readUInt32BE(position);
  if (start + 12 > bytes.length) throw new Error('Invalid TTC font directory');
  const count = bytes.readUInt16BE(start + 4);
  if (start + 12 + count * 16 > bytes.length) throw new Error('Invalid TTC font tables');
  let size = 12 + count * 16;
  const tables = [];
  for (let i = 0; i < count; i += 1) {
    const record = start + 12 + i * 16;
    const offset = bytes.readUInt32BE(record + 8); const length = bytes.readUInt32BE(record + 12);
    if (offset + length > bytes.length) throw new Error('Invalid TTC table bounds');
    tables.push({ record, offset, length, destination: size });
    size += (length + 3) & ~3;
  }
  const result = Buffer.alloc(size);
  bytes.copy(result, 0, start, start + 12 + count * 16);
  let head;
  tables.forEach(({ record, offset, length, destination }, i) => {
    bytes.copy(result, destination, offset, offset + length);
    result.writeUInt32BE(destination, 12 + i * 16 + 8);
    if (bytes.toString('ascii', record, record + 4) === 'head') head = destination;
  });
  if (head !== undefined) {
    result.writeUInt32BE(0, head + 8);
    let checksum = 0;
    for (let i = 0; i < result.length; i += 4) checksum = (checksum + result.readUInt32BE(i)) >>> 0;
    result.writeUInt32BE((0xB1B0AFBA - checksum) >>> 0, head + 8);
  }
  return result;
}

// A per-document resolver embeds only used glyphs and preserves Latin font choice
// while falling back per character for CJK or other unsupported Unicode glyphs.
export async function createAnnotationFontResolver(pdf, warnings, { fontDirectories } = {}) {
  const fontkit = await annotationFontkit();
  pdf.registerFontkit(fontkit);
  const directories = fontDirectories || [path.join(process.env.WINDIR || 'C:/Windows', 'Fonts'), path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Windows/Fonts'), '/usr/share/fonts/truetype/noto', '/usr/share/fonts/opentype/noto', '/Library/Fonts'];
  const cache = new Map();
  // A fresh prefix avoids overwriting DA resources when an annotated PDF is exported again.
  const resourcePrefix = `PRF${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  async function load(family, bold, italic) {
    const key = `${family}:${bold}:${italic}`;
    if (cache.has(key)) return cache.get(key);
    const candidates = ANNOTATION_FONTS[family];
    const noto = family.startsWith('Noto');
    const style = (bold ? 1 : 0) + (italic ? 2 : 0);
    const files = noto ? candidates : [...new Set([candidates[style] || candidates[0], candidates[0]])];
    for (const filename of files) for (const directory of directories) {
      try {
        const raw = await readFile(path.join(directory, filename));
        // PMingLiU is the proportional second face; JhengHei uses the first face.
        const data = extractTtcFont(raw, family === 'PMingLiU' ? 1 : 0);
        const parsed = fontkit.create(data);
        const result = { data, parsed, family, resource: `${resourcePrefix}${cache.size + 1}`, syntheticBold: bold && (noto || !filename.includes('bd') && !['georgiab.ttf', 'georgiaz.ttf', 'consolab.ttf', 'consolaz.ttf', 'arialbi.ttf', 'timesbi.ttf'].includes(filename)), syntheticItalic: italic && (noto || !['ariali.ttf', 'arialbi.ttf', 'timesi.ttf', 'timesbi.ttf', 'georgiai.ttf', 'georgiaz.ttf', 'consolai.ttf', 'consolaz.ttf'].includes(filename)) };
        cache.set(key, result);
        return result;
      } catch (error) {
        if (error.code !== 'ENOENT') warnings.add(`無法使用字型 ${family} (${filename})：${error.message}`);
      }
    }
    cache.set(key, null);
    return null;
  }
  return async (text, annotation) => {
    const families = [...new Set([annotation.font, 'Microsoft JhengHei', 'Noto Sans TC', 'DFKai-SB', 'PMingLiU', 'Arial'])];
    const fonts = [];
    for (const family of families) {
      const font = await load(family, annotation.bold, annotation.italic);
      if (font) fonts.push(font);
    }
    if (!fonts.length) throw new Error('找不到可嵌入的本機字型。請安裝 Microsoft JhengHei 或 Noto Sans TC 後重新匯出。');
    const glyphs = [];
    for (const character of text) {
      if (character === '\n') { glyphs.push({ character }); continue; }
      const codepoint = character.codePointAt(0);
      const selected = fonts.find(({ parsed }) => parsed.hasGlyphForCodePoint(codepoint));
      if (!selected) throw new Error(`本機字型不包含字元 U+${codepoint.toString(16).toUpperCase()} (${character})，請安裝涵蓋該字元的字型。`);
      if (selected.family !== annotation.font) warnings.add(`${annotation.font} 缺少字元或未安裝，部分文字改用 ${selected.family}。`);
      // Unused fallback candidates must not create empty embedded font subsets.
      selected.font ||= await pdf.embedFont(selected.data, { subset: true });
      const { data, ...font } = selected;
      glyphs.push({ character, ...font });
    }
    return glyphs;
  };
}
