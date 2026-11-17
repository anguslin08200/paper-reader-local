import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAllElements, extractElements, buildHotspots, extractTextBlocks, findCounterpart } from '../src/server/elements.js';

// Side-by-side bilingual page: English on the left half, translation mirrored on the right half.
const middle = { pages: [{ page_idx: 3, blocks: [
  { type: 'image', index: 1, bbox: [0.04, 0.10, 0.24, 0.47], content: [
    { type: 'image_body', image_path: 'images/page_3_image_1.jpg' },
    { type: 'image_caption', content: [{ type: 'text', content: 'Figure 3: Overview.' }] }] },
  { type: 'image', index: 2, bbox: [0.54, 0.10, 0.74, 0.47], content: [
    { type: 'image_body', image_path: 'images/page_3_image_2.jpg' },
    { type: 'image_caption', content: [{ type: 'text', content: '圖 3：概覽。' }] }] },
  { type: 'code', index: 3, bbox: [0.26, 0.11, 0.46, 0.56], content: [{ type: 'algorithm_body', content: [{ type: 'text', content: 'Algorithm 1: Q' }] }] },
  { type: 'code', index: 4, bbox: [0.76, 0.11, 0.96, 0.56], content: [{ type: 'algorithm_body', content: [{ type: 'text', content: 'Algorithm 1: Q' }] }] },
  { type: 'text', index: 5, bbox: [0.04, 0.55, 0.24, 0.60], content: [{ type: 'text', content: 'English paragraph A.' }] },
  { type: 'text', index: 6, bbox: [0.26, 0.76, 0.46, 0.90], content: [{ type: 'text', content: 'English paragraph B.' }] },
  { type: 'text', index: 7, bbox: [0.54, 0.55, 0.74, 0.60], content: [{ type: 'text', content: '中文段落甲。' }] },
  { type: 'text', index: 8, bbox: [0.76, 0.75, 0.96, 0.87], content: [{ type: 'text', content: '中文段落乙。' }] },
] }] };

test('translated copies on the right half become hotspots pointing at the English twin', () => {
  const all = extractAllElements(middle);
  const kept = extractElements(middle);
  assert.deepEqual(kept.map((item) => item.label), ['Figure 3', 'Algorithm 1']);
  const spots = buildHotspots(all, kept);
  assert.equal(spots.length, 4);
  const right = spots.filter((spot) => spot.mirrored);
  assert.equal(right.length, 2);
  for (const spot of right) assert.equal(kept.find((item) => item.id === spot.targetId).kind, spot.kind);
  assert.equal(right.find((spot) => spot.kind === 'figure').localCaption, '圖 3：概覽。');
});

test('selections map to the paragraph on the other half in both directions', () => {
  const blocks = extractTextBlocks(middle);
  const fromChinese = findCounterpart(blocks, 4, { x: 0.77, y: 0.76, w: 0.15, h: 0.05 });
  assert.deepEqual([fromChinese.side, fromChinese.otherLang, fromChinese.text], ['right', 'en', 'English paragraph B.']);
  const fromEnglish = findCounterpart(blocks, 4, { x: 0.05, y: 0.56, w: 0.1, h: 0.02 });
  assert.deepEqual([fromEnglish.side, fromEnglish.otherLang, fromEnglish.text], ['left', 'zh', '中文段落甲。']);
  assert.equal(findCounterpart(blocks, 9, { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }), null);
});
