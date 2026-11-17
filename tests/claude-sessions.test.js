import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeSessionStore } from '../src/server/claude-sessions.js';

const conversation = 'e52bbe07-64f2-4d63-bfa3-09aed5aa0e8a';
const nextConversation = '17d711eb-d405-4113-9801-3be4e48f029c';
const scope = { paperId: 'paper-a', conversationId: conversation, model: 'sonnet' };

test('Claude sessions resume only their own paper, conversation and model', async () => {
  let id = 0;
  const store = createClaudeSessionStore({ newId: () => `session-${++id}` });
  const capture = (session) => session;
  assert.deepEqual(await store.run(scope, capture), { sessionId: 'session-1', resume: false });
  assert.deepEqual(await store.run(scope, capture), { sessionId: 'session-1', resume: true });
  assert.deepEqual(await store.run({ ...scope, paperId: 'paper-b' }, capture), { sessionId: 'session-2', resume: false });
  assert.deepEqual(await store.run({ ...scope, conversationId: nextConversation }, capture), { sessionId: 'session-3', resume: false });
  assert.deepEqual(await store.run({ ...scope, model: 'haiku' }, capture), { sessionId: 'session-4', resume: false });
  assert.equal((await store.run(scope, capture)).sessionId, 'session-1');
});

test('Claude sessions reject overlapping turns rather than corrupt the CLI history', async () => {
  const store = createClaudeSessionStore();
  let release;
  const pending = store.run(scope, () => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(store.run(scope, () => {}), /正在回答/);
  release('done');
  assert.equal(await pending, 'done');
  assert.equal(await store.run(scope, (session) => session.resume), true);
});

test('first-turn failures use a fresh session on retry while resumed failures preserve previous history', async () => {
  let id = 0;
  const store = createClaudeSessionStore({ newId: () => `session-${++id}` });
  const fail = () => { throw new Error('failed'); };
  await assert.rejects(store.run(scope, fail), /failed/);
  assert.deepEqual(await store.run(scope, (session) => session), { sessionId: 'session-2', resume: false });
  await assert.rejects(store.run(scope, fail), /failed/);
  assert.deepEqual(await store.run(scope, (session) => session), { sessionId: 'session-2', resume: true });
});

test('expired and idle Claude sessions are bounded without evicting active requests', async () => {
  let time = 0, id = 0;
  const store = createClaudeSessionStore({ newId: () => `session-${++id}`, now: () => time, ttlMs: 10, limit: 1 });
  await store.run(scope, () => {});
  time = 20;
  assert.equal(await store.run(scope, (session) => session.resume), false);
  let release;
  const pending = store.run(scope, () => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(store.run({ ...scope, paperId: 'other' }, () => {}), /繁忙/);
  release(); await pending;
  assert.equal(await store.run({ ...scope, paperId: 'other' }, (session) => session.resume), false);
});

test('invalid conversation tokens never reach the CLI', async () => {
  const store = createClaudeSessionStore();
  await assert.rejects(store.run({ ...scope, conversationId: '../../other' }, () => assert.fail('must not launch')), /ID 無效/);
  // Older API clients can still reuse a per-paper default conversation without providing a token.
  await store.run({ paperId: 'legacy' }, () => {});
  assert.equal(await store.run({ paperId: 'legacy' }, (session) => session.resume), true);
});
