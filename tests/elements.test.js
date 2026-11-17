import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { extractElements, elementImagePath, flattenContent } from '../src/server/elements.js';

// Minimal MinerU middle_json fixture covering every element kind and a bilingual duplicate.
const middle = { pages: [
  { page_idx: 0, blocks: [
    { type: 'image', index: 1, bbox: [0.1, 0.1, 0.45, 0.4], content: [
      { type: 'image_body', image_path: 'images/page_0_image_1.jpg', content: '' },
      { type: 'image_caption', content: [{ type: 'text', content: 'Figure 3: Overview of the framework.' }] }] },
    { type: 'image', index: 2, bbox: [0.6, 0.1, 0.95, 0.4], content: [
      { type: 'image_body', image_path: 'images/page_0_image_2.jpg', content: '' },
      { type: 'image_caption', content: [{ type: 'text', content: '圖 3：框架概覽。' }] }] },
    { type: 'image', index: 3, bbox: [0.04, 0.82, 0.07, 0.84], content: [{ type: 'image_body', image_path: 'images/page_0_logo.jpg', content: '' }] },
    { type: 'code', index: 4, bbox: [0.1, 0.5, 0.45, 0.9], content: [{ type: 'algorithm_body', content: [
      { type: 'text', content: 'Algorithm 1: Quantization\nInput: ' }, { type: 'equation_inline', content: 'W' }] }] },
  ] },
  { page_idx: 1, blocks: [
    { type: 'table', index: 5, bbox: [0.1, 0.1, 0.9, 0.3], content: [
      { type: 'table_body', image_path: 'images/page_1_table_5.jpg', content: '<table><tr><td>1</td></tr></table>' },
      { type: 'table_caption', content: [{ type: 'text', content: 'TABLE II: Results.' }] }] },
    { type: 'equation', index: 6, bbox: [0.3, 0.5, 0.6, 0.55], image_path: 'images/page_1_equation_6.jpg', content: 's = a + b\tag{1}' },
  ] },
] };

test('extracts figures, tables, algorithms and equations with labels and exact text', () => {
  const elements = extractElements(middle);
  assert.deepEqual(elements.map((item) => [item.kind, item.label, item.page]), [
    ['figure', 'Figure 3', 1], ['table', 'Table II', 2], ['algorithm', 'Algorithm 1', 1], ['equation', '第 2 頁公式', 2],
  ]);
  assert.match(elements.find((item) => item.kind === 'algorithm').text, /Input: \$W\$/);
  assert.equal(elements.find((item) => item.kind === 'equation').text, '$$s = a + b\tag{1}$$');
});

test('drops tiny logos and the translated half of side-by-side bilingual pages', () => {
  const files = extractElements(middle).map((item) => item.image);
  assert.ok(!files.includes('images/page_0_logo.jpg'));
  assert.ok(!files.includes('images/page_0_image_2.jpg'));
});

test('flattens inline equations and nested spans', () => {
  assert.equal(flattenContent([{ type: 'text', content: 'a ' }, { type: 'equation_inline', content: 'x^2' }]), 'a $x^2$');
});

test('element images resolve only inside parsed/images', () => {
  const root = path.resolve('paper-dir');
  assert.equal(elementImagePath(root, 'images/page_0_image_1.jpg'), path.join(root, 'parsed', 'images', 'page_0_image_1.jpg'));
  for (const bad of ['../original.pdf', 'images/../../x.jpg', 'images/a/b.jpg', 'parse-status.json', null]) assert.equal(elementImagePath(root, bad), null);
});
