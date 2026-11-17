// Keep reader helpers free of browser and PDF.js imports so the UI and tests can share them.

export function findTextMatches(items, query) {
  const text = (items ?? []).map((item) => {
    const part = typeof item?.str === 'string' ? item.str : '';
    return `${part}${item?.hasEOL ? '\n' : ''}`;
  }).join('');
  const matches = [];
  const needle = String(query ?? '');

  // Match against the raw concatenated text so offsets remain usable with PDF.js item spans.
  if (!needle) return { text, matches };
  // Collapse query whitespace to \s+ so phrases can span PDF.js line breaks and spans.
  const escaped = needle.split(/\s+/u).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  const pattern = new RegExp(escaped, 'giu');
  for (const match of text.matchAll(pattern)) {
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return { text, matches };
}

function oneLine(value) {
  // Prevent supplied titles from escaping their Markdown heading line.
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function quoteMarkdown(value) {
  // Quote every line, including blank lines, while leaving the original Markdown syntax intact.
  return String(value ?? '').split(/\r?\n/).map((line) => `> ${line}`).join('\n');
}

export function chatMarkdown(title, messages) {
  const blocks = [`# ${oneLine(title)}`];
  for (const message of messages ?? []) {
    const roleLabels = { user: '使用者', assistant: '論文助手' };
    const rawRole = oneLine(message?.role || 'unknown');
    const role = roleLabels[rawRole] || rawRole;
    const body = message?.content ?? message?.text ?? '';
    blocks.push(`## ${role}\n\n${quoteMarkdown(body)}`);
  }
  return `${blocks.join('\n\n')}\n`;
}

export function notesMarkdown(title, annotations) {
  const blocks = [`# ${oneLine(title)}`];
  for (const annotation of annotations ?? []) {
    const page = oneLine(annotation?.page ?? '');
    const colorNames = { yellow: '黃色', green: '綠色', pink: '粉紅色', blue: '藍色' };
    const variantNames = { original: '原文', chinese: '中文', bilingual: '雙語' };
    const rawColor = oneLine(annotation?.color ?? '');
    const color = colorNames[rawColor] || rawColor;
    const variant = variantNames[annotation?.variant] || oneLine(annotation?.variant ?? '');
    const text = annotation?.text ?? '';
    const note = annotation?.note ?? '';
    const details = [`## 第 ${page} 頁${variant ? `（${variant}）` : ''}`];
    if (color) details.push(`顏色：${color}`);
    if (text !== '') details.push(`原文：\n\n${quoteMarkdown(text)}`);
    if (note !== '') details.push(`註記：\n\n${quoteMarkdown(note)}`);
    blocks.push(details.join('\n\n'));
  }
  return `${blocks.join('\n\n')}\n`;
}

export function shouldReleasePage(page, current, radius = 4) {
  // Keep the current page and its nearby pages resident for smooth navigation.
  return !Number.isFinite(page) || !Number.isFinite(current)
    ? true
    : Math.abs(page - current) > Math.max(0, Number(radius) || 0);
}

export function relativeReadTime(date, now = Date.now()) {
  // Missing reading timestamps are shown explicitly instead of being treated as the Unix epoch.
  if (date === null || date === undefined || date === '') return '未閱讀';
  const timestamp = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (!Number.isFinite(timestamp)) return '';

  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return '剛剛';
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分鐘前`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))} 小時前`;
  if (elapsed < 30 * 24 * 60 * 60_000) {
    const days = Math.floor(elapsed / (24 * 60 * 60_000));
    return days === 1 ? '昨天' : `${days} 天前`;
  }

  // Use Taiwan's local date conventions once a relative day label is no longer useful.
  const parts = new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'Asia/Taipei',
  }).formatToParts(timestamp);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}年${month}月${day}日`;
}
