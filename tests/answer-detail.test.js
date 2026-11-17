import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ANSWER_DETAIL_DEFAULTS, answerDetailInstructions } from '../src/server/answer-detail.js';
import { buildPaperInput } from '../src/server/codex.js';
import { runPaperAgent } from '../src/server/pi.js';
import { mergeSettings, publicSettings } from '../src/server/settings.js';

// Selection is independent for depth and example, and rejects unrecognized input.
test('answer modifiers map exact values and retain editable defaults', () => {
  const prompts = { detailSimple: 'brief custom', detailDetailed: 'deep custom', exampleSimple: 'short example', exampleFull: 'full example' };
  assert.deepEqual(answerDetailInstructions('simple', 'simple', prompts), ['brief custom', 'short example']);
  assert.deepEqual(answerDetailInstructions('detailed', 'full', prompts), ['deep custom', 'full example']);
  assert.deepEqual(answerDetailInstructions('medium', undefined, prompts), []);
  assert.deepEqual(answerDetailInstructions('medium', 'full', prompts), ['full example']);
  assert.deepEqual(answerDetailInstructions({}, ['full'], prompts), []);
  assert.deepEqual(answerDetailInstructions('toString', 'invalid', prompts), []);
  assert.deepEqual(answerDetailInstructions('simple', 'full', {}), [ANSWER_DETAIL_DEFAULTS.detailSimple, ANSWER_DETAIL_DEFAULTS.exampleFull]);
  assert.deepEqual(answerDetailInstructions('simple', null, { detailSimple: '' }), [ANSWER_DETAIL_DEFAULTS.detailSimple]);
  assert.deepEqual(Object.fromEntries(Object.keys(ANSWER_DETAIL_DEFAULTS).map((key) => [key, mergeSettings().prompts[key]])), ANSWER_DETAIL_DEFAULTS);
  assert.equal(publicSettings(mergeSettings({ prompts })).prompts.detailSimple, 'brief custom');
});

test('paper input places modifiers between template and context', () => {
  const settings = { prompts: { question: 'template', detailDetailed: 'deep custom', exampleFull: 'full custom' } };
  const input = buildPaperInput({ task: 'question', detail: 'detailed', exampleLevel: 'full', question: 'Q' }, settings);
  assert.ok(input.indexOf('template') < input.indexOf('deep custom'));
  assert.ok(input.indexOf('deep custom') < input.indexOf('full custom'));
  assert.ok(input.indexOf('full custom') < input.indexOf('Q'));
  assert.equal(buildPaperInput({ detail: 'medium' }, settings), buildPaperInput({}, settings));
  assert.equal(buildPaperInput({ detail: 1, exampleLevel: {} }, settings), buildPaperInput({}, settings));
  assert.equal(buildPaperInput({ detail: 'invalid', exampleLevel: 'toString' }, settings), buildPaperInput({}, settings));
  const simple = buildPaperInput({ detail: 'simple', exampleLevel: 'simple' }, settings);
  assert.ok(simple.includes(ANSWER_DETAIL_DEFAULTS.detailSimple));
  assert.ok(simple.includes(ANSWER_DETAIL_DEFAULTS.exampleSimple));
});

// Inspect the actual Pi request file through its injected runner without starting a provider.
test('Pi request applies configured modifiers after template marker', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-detail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let prompt;
  await runPaperAgent({ question: 'Q', task: 'summary', detail: 'simple', exampleLevel: 'full' }, {
    settings: { agent: { provider: 'pi', thinking: 'off' }, prompts: { detailSimple: 'brief custom', exampleFull: 'full custom' } },
    promptDirectory: path.join(root, 'requests'), templateDirectory: path.join(root, 'templates'),
    runPi: async (_settings, args) => { prompt = await readFile(args.find((arg) => arg.startsWith('@')).slice(1), 'utf8'); },
  });
  assert.ok(prompt.startsWith('/paper-summary\n\nbrief custom\n\nfull custom\n\n'));
  assert.ok(prompt.indexOf('full custom') < prompt.indexOf('Q'));
});
