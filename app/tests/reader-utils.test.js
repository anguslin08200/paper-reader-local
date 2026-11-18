import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chatMarkdown,
  findTextMatches,
  notesMarkdown,
  relativeReadTime,
  shouldReleasePage,
} from '../src/web/reader-utils.js';

test('finds literal case-insensitive matches across PDF.js spans with raw offsets', () => {
  const result = findTextMatches([
    { str: '中文Hel' },
    { str: 'Lo world' },
    { str: 'NEXT', hasEOL: true },
    { str: 'line' },
  ], 'hello');

  assert.equal(result.text, '中文HelLo worldNEXT\nline');
  assert.deepEqual(result.matches, [{ start: 2, end: 7 }]);
  assert.deepEqual(findTextMatches([{ str: 'NEXT\nline' }], 'next\nLINE').matches, [
    { start: 0, end: 9 },
  ]);
  const phrase = findTextMatches([{ str: 'before HELLO' }, { str: ' WORLD', hasEOL: true }, { str: 'after' }], 'hello   world');
  assert.deepEqual(phrase.matches, [{ start: 7, end: 18 }]);
});

test('treats search text as a literal and returns no empty-query matches', () => {
  assert.deepEqual(findTextMatches([{ str: 'a+b a.b [x]' }], 'a+b').matches, [
    { start: 0, end: 3 },
  ]);
  assert.deepEqual(findTextMatches([{ str: 'text' }], '').matches, []);
});

// Bilingual text and PDF-generated line breaks must preserve the offsets used by hit rectangles.
test('matches Chinese across spans and phrases across PDF line breaks', () => {
  const items = [{ str: '雙語搜' }, { str: '尋示範', hasEOL: true }, { str: 'HELLO' }, { str: ' world' }];
  assert.deepEqual(findTextMatches(items, '搜尋').matches, [{ start: 2, end: 4 }]);
  assert.deepEqual(findTextMatches(items, '示範 hello').matches, [{ start: 4, end: 12 }]);
});

test('exports chat Markdown with Taiwan role labels, safe headings, and preserved body Markdown', () => {
  const markdown = chatMarkdown('Paper\n# injected', [
    { role: 'assistant', content: '**Answer**\n\n- first\n- second' },
    { role: 'user', text: 'Question' },
  ]);

  assert.equal(markdown, '# Paper # injected\n\n## 論文助手\n\n> **Answer**\n> \n> - first\n> - second\n\n## 使用者\n\n> Question\n');
});

test('exports annotation pages, Taiwan labels, variants, and multiline Markdown', () => {
  const markdown = notesMarkdown('Notes', [{
    page: 3,
    color: 'yellow',
    variant: 'original',
    text: 'Selected **text**',
    note: 'First line\nSecond line',
  }, {
    page: 4,
    color: 'pink',
    variant: 'bilingual',
    note: 'A bilingual note',
  }]);

  assert.equal(markdown, '# Notes\n\n## 第 3 頁（原文）\n\n顏色：黃色\n\n原文：\n\n> Selected **text**\n\n註記：\n\n> First line\n> Second line\n\n## 第 4 頁（雙語）\n\n顏色：粉紅色\n\n註記：\n\n> A bilingual note\n');
});

test('releases pages only outside the retained radius', () => {
  assert.equal(shouldReleasePage(6, 10), false);
  assert.equal(shouldReleasePage(5, 10), true);
  assert.equal(shouldReleasePage(10, 10), false);
  assert.equal(shouldReleasePage(3, 10, 2), true);
});

test('formats reading times with Taiwan Traditional Chinese labels', () => {
  const now = Date.UTC(2026, 0, 31, 12);

  assert.equal(relativeReadTime(now - 30_000, now), '剛剛');
  assert.equal(relativeReadTime(now - 5 * 60_000, now), '5 分鐘前');
  assert.equal(relativeReadTime(now - 3 * 60 * 60_000, now), '3 小時前');
  assert.equal(relativeReadTime(now - 24 * 60 * 60_000, now), '昨天');
  assert.equal(relativeReadTime(now - 3 * 24 * 60 * 60_000, now), '3 天前');
  assert.equal(relativeReadTime(now - 31 * 24 * 60 * 60_000, now), '2025年12月31日');
  assert.equal(relativeReadTime(null, now), '未閱讀');
  assert.equal(relativeReadTime(undefined, now), '未閱讀');
  assert.equal(relativeReadTime('', now), '未閱讀');
});
