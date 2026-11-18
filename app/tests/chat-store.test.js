import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readChat, updateChat, resetChat, appendTurn, historyContext } from '../src/server/chat-store.js';
import { buildPaperInput } from '../src/server/codex.js';

test('per-paper chat persists turns and resets', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chat-store-'));
  try {
    assert.deepEqual((await readChat(directory)).turns, []);
    await updateChat(directory, (chat) => { appendTurn(chat, { question: 'Q1', answer: 'A1', task: 'question', label: '' }); chat.claude = { sessionId: 's', ready: true, model: 'sonnet', turns: 1 }; });
    await updateChat(directory, (chat) => appendTurn(chat, { question: 'Q2', answer: 'A2', task: 'term', label: 'Hessian' }));
    const chat = await readChat(directory);
    assert.deepEqual(chat.turns.map((turn) => turn.question), ['Q1', 'Q2']);
    assert.equal(chat.claude.sessionId, 's');
    assert.deepEqual((await resetChat(directory)).turns, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('concurrent updates do not lose turns', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chat-store-'));
  try {
    await Promise.all(Array.from({ length: 10 }, (_, index) => updateChat(directory, (chat) => appendTurn(chat, { question: `Q${index}`, answer: 'A', task: 'question' }))));
    assert.equal((await readChat(directory)).turns.length, 10);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('history keeps recent turns within budget and reaches the Codex prompt', () => {
  const turns = Array.from({ length: 12 }, (_, index) => ({ question: `問題${index + 1}`, answer: 'x'.repeat(3000), label: index === 11 ? 'Algorithm 1' : '' }));
  const history = historyContext(turns);
  assert.ok(!history.includes('問題4'), 'older turns are dropped');
  assert.ok(history.includes('問題12') && history.includes('附件：Algorithm 1'));
  assert.ok(history.length <= 16000);
  const prompt = buildPaperInput({ question: '那它呢？', context: { history }, task: 'question' }, { prompts: { question: 'Q' } });
  assert.match(prompt, /# 先前對話/);
  assert.match(prompt, /問題12/);
});
