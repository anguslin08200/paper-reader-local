import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAttachments } from '../src/server/attachments.js';
import { buildPaperInput } from '../src/server/codex.js';
import { mergeSettings, PROMPT_TASKS } from '../src/server/settings.js';

const image = (n) => `data:image/png;base64,${Buffer.from(String(n)).toString('base64')}`;
const elements = Array.from({ length: 8 }, (_, i) => ({ id: `e${i}`, label: `Figure ${i}`, page: i + 1, image: `images/${i}.png`, caption: `caption ${i}`, text: `source ${i}` }));
const resolve = (body) => resolveAttachments(body, elements, async (element) => image(`auto${element.id}`));

test('groups ordered crop and text, preserves source, and numbers prompt images', async () => {
  const attachments = await resolve({ elementIds: ['e0', 'e1'], selectedTexts: [{ text: 'selection', page: 4, counterpart: 'translation' }], images: [image(1), image(2)], attachmentOrder: [{ type: 'image', index: 1, textIndex: 0, label: 'crop' }, { type: 'element', index: 0, imageIndex: 0 }] });
  assert.equal(attachments.length, 3);
  assert.equal(attachments[0].text.counterpart, 'translation');
  assert.equal(attachments[1].element.text, 'source 0');
  assert.equal(attachments[1].image, image(1));
  assert.equal(attachments[2].image, image('autoe1'));
  const prompt = buildPaperInput({ task: 'compare', context: { attachments }, question: 'compare' }, mergeSettings());
  assert.match(prompt, /\u9644\u4ef6 1.*crop/s);
  assert.match(prompt, /\u9644\u4ef6 2.*Figure 0/s);
  assert.match(prompt, /source 0/);
  assert.match(prompt, /translation/);
  assert.ok(PROMPT_TASKS.includes('compare'));
  assert.ok(mergeSettings({ prompts: { compare: 'custom' } }).prompts.compare === 'custom');
});

test('caps and deduplicates logical attachments and images with invalid metadata', async () => {
  const attachments = await resolve({ elementIds: ['e0', 'e0', 'missing', ...elements.map((e) => e.id)], images: [image(1), image(1), image(2), image(3), image(4), image(5)], attachmentOrder: [{ type: 'image', index: 0 }, { type: 'invalid', index: 1 }, { type: 'element', index: -1 }] });
  assert.equal(attachments.length, 6);
  assert.equal(new Set(attachments.filter((a) => a.element).map((a) => a.element.id)).size, 5);
  assert.equal(attachments.filter((a) => a.image).length, 4);
});

test('legacy screenshot is grouped with element and selected text', async () => {
  const attachments = await resolve({ elementId: 'e0', imageData: image(1), selectedText: 'old', counterpart: 'other', page: 2 });
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].image, image(1));
  assert.equal(attachments[0].text.text, 'old');
  assert.equal(attachments[0].element.id, 'e0');
});

test('legacy image and selected text share one attachment, while text-only retains counterpart', async () => {
  const grouped = await resolve({ imageData: image(1), selectedText: 'source', counterpart: 'translated', page: 3 });
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].image, image(1));
  assert.deepEqual(grouped[0].text, { text: 'source', counterpart: 'translated', page: 3, label: '' });
  const textOnly = await resolve({ selectedText: 'source', counterpart: 'translated', page: 3 });
  assert.equal(textOnly.length, 1);
  assert.equal(textOnly[0].text.counterpart, 'translated');
  assert.equal(textOnly[0].text.page, 3);
});

test('limits distinct explicit images to four even when there are more attachment slots', async () => {
  const attachments = await resolve({ images: Array.from({ length: 6 }, (_, i) => image(i)), selectedTexts: [{ text: 'after images' }], attachmentOrder: Array.from({ length: 6 }, (_, index) => ({ type: 'image', index })) });
  assert.equal(attachments.filter((item) => item.image).length, 4);
  assert.equal(attachments.length, 5);
  assert.equal(attachments[4].text.text, 'after images');
});
