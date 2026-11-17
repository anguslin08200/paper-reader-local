import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentPayload, updateAttachments } from '../src/web/attachment-utils.js';

// The same reducer handles PDF clicks, the figure list and Ctrl text selections.
test('ordinary selection replaces; Ctrl adds, toggles elements and deduplicates text', () => {
  const first = { elementId: 'fig1' }; const second = { elementId: 'fig2' };
  assert.deepEqual(updateAttachments([first], second).attachments, [second]);
  assert.deepEqual(updateAttachments([first], second, true).attachments, [first, second]);
  assert.deepEqual(updateAttachments([first, second], { elementId: 'fig1' }, true).attachments, [second]);
  const text = { text: '文字', page: 2 };
  assert.equal(updateAttachments([text], { ...text }, true).attachments.length, 1);
  assert.equal(updateAttachments([text], { ...text, page: 3 }, true).attachments.length, 2);
});

test('enforces six logical attachments and four explicit images', () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ elementId: `fig${i}` }));
  assert.match(updateAttachments(six, { text: 'more' }, true).error, /6/);
  const images = Array.from({ length: 4 }, (_, i) => ({ id: String(i), imageData: `image${i}` }));
  assert.match(updateAttachments(images, { id: '5', imageData: 'image5' }, true).error, /4/);
  assert.equal(updateAttachments(images, { text: 'allowed' }, true).attachments.length, 5);
  assert.equal(updateAttachments(six, { elementId: 'replacement' }).attachments.length, 1);
});

test('serializes mixed attachments in visible order, grouping crop images and source text', () => {
  const result = attachmentPayload([
    { label: '段落', page: 3, text: 'original', counterpart: '對照' },
    { label: 'Figure 1', page: 1, elementId: 'fig1', imageData: 'crop', text: 'crop text' },
    { label: '上傳圖片', imageData: 'upload' },
  ]);
  assert.deepEqual(result.elementIds, ['fig1']);
  assert.deepEqual(result.images, ['crop', 'upload']);
  assert.deepEqual(result.selectedTexts[0], { text: 'original', page: 3, counterpart: '對照', label: '段落' });
  assert.deepEqual(result.attachmentOrder, [
    { type: 'text', index: 0, label: '段落', page: 3 },
    { type: 'element', index: 0, label: 'Figure 1', page: 1, imageIndex: 0, textIndex: 1 },
    { type: 'image', index: 1, label: '上傳圖片', page: undefined },
  ]);
  assert.equal(result.attachmentLabel, '段落、Figure 1、上傳圖片');
});
