import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveClaudeLaunch, runClaudePaperAgent, runClaudeTranslation } from '../src/server/claude.js';
import { abortOnResponseClose } from '../src/server/response-abort.js';

// Fake children exercise the actual stream framing without starting inference.
function fakeChild(action) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
  child.kill = () => { child.killed = true; };
  let input = '';
  child.stdin = new Writable({ write(chunk, _enc, cb) { input += chunk; cb(); }, final(cb) { queueMicrotask(() => action(child, input)); cb(); } });
  let call;
  return { child, spawnProcess: (command, args, options) => { call = { command, args, options }; return child; }, get call() { return call; } };
}
const settings = { agent: { claudeModel: 'sonnet' }, translation: { claudeModel: 'other-model' }, prompts: {} };
const id = '12345678-1234-4234-8234-123456789abc';
const event = (value) => `${JSON.stringify(value)}\n`;
const result = (text) => ({ type: 'result', subtype: 'success', is_error: false, result: text });
async function workspace(t) { const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-bridge-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function paper(cwd, fake, extra = {}) { return runClaudePaperAgent({ cwd, context: { paper: { id: 'paper', title: 'Title' } }, question: 'Q', sessionId: id, spawnProcess: fake.spawnProcess, command: 'fake', ...extra }, settings); }

test('streams UTF-8 partial events, restricts tools and clears inherited billing overrides', async (t) => {
  const cwd = await workspace(t); const old = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'secret';
  t.after(() => { if (old === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = old; });
  const fake = fakeChild((child, input) => {
    assert.match(input, /Q/);
    const bytes = Buffer.from(event({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '中文' } } }));
    const split = bytes.indexOf(Buffer.from('中')) + 1; child.stdout.write(bytes.subarray(0, split)); child.stdout.write(bytes.subarray(split));
    child.stdout.write(event(result('中文'))); child.emit('close', 0);
  });
  let streamed = ''; const output = await paper(cwd, fake, { onDelta: (s) => { streamed += s; } });
  assert.deepEqual(output, { text: '中文', sessionId: id }); assert.equal(streamed, '中文');
  const { args, options } = fake.call;
  for (const arg of ['--safe-mode', '--restricted', '--strict-mcp-config', '--permission-prompts', '--session-id', '--allowedTools']) assert.ok(args.includes(arg));
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'manual');
  assert.equal(options.env.ANTHROPIC_API_KEY, undefined); assert.equal(options.cwd, cwd);
});

test('resume uses session ID and fallback result emits once', async (t) => {
  const cwd = await workspace(t); const fake = fakeChild((child, input) => { assert.doesNotMatch(input, /old answer/); child.stdout.write(event(result('complete'))); child.emit('close', 0); });
  const deltas = []; await paper(cwd, fake, { resume: true, context: { paper: { id: 'paper' }, previousAnswer: 'old answer' }, onDelta: (s) => deltas.push(s) });
  assert.deepEqual(deltas, ['complete']); assert.equal(fake.call.args[fake.call.args.indexOf('--resume') + 1], id);
  assert.equal(fake.call.args.includes('--session-id'), false);
});

test('translation disables tools and session persistence', async (t) => {
  const cwd = await workspace(t); const fake = fakeChild((child) => { child.stdout.write(event(result('translated'))); child.emit('close', 0); });
  assert.equal(await runClaudeTranslation('text', { cwd, settings, model: 'chosen-model', command: 'fake', spawnProcess: fake.spawnProcess }), 'translated');
  assert.equal(fake.call.args[fake.call.args.indexOf('--tools') + 1], '');
  assert.ok(fake.call.args.includes('--no-session-persistence')); assert.ok(fake.call.args.includes('chosen-model'));
  assert.match(fake.call.args[fake.call.args.indexOf('--append-system-prompt') + 1], /台灣用語/);
});

test('empty successful results are reported as errors instead of cached as empty translations', async (t) => {
  const cwd = await workspace(t);
  const fake = fakeChild((child) => { child.stdout.write(event(result('  '))); child.emit('close', 0); });
  await assert.rejects(paper(cwd, fake), /空回覆/);
});

for (const [name, action, expected] of [
  ['error result', (c) => c.stdout.write(event({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'secret' })), /error_during_execution/],
  ['missing result', (c) => c.emit('close', 0), /no result/],
  ['failed exit', (c) => c.emit('close', 1), /1/],
  ['spawn error', (c) => c.emit('error', new Error('secret')), /failed to start/],
]) test(`rejects ${name} safely`, async (t) => {
  const cwd = await workspace(t); const fake = fakeChild(action);
  await assert.rejects(paper(cwd, fake), expected); assert.equal(fake.child.killed, true);
});

test('timeout and cancellation terminate the child', async (t) => {
  const cwd = await workspace(t); const fake = fakeChild(() => {});
  await assert.rejects(paper(cwd, fake, { timeoutMs: 10 }), /timed out/); assert.ok(fake.child.killed);
  const other = fakeChild(() => {}); const controller = new AbortController();
  const promise = paper(cwd, other, { signal: controller.signal }); setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, /aborted/); assert.ok(other.child.killed);
});

test('image is present during execution and removed even on failure', async (t) => {
  const cwd = await workspace(t); const fake = fakeChild(async (child, input) => {
    assert.match(input, /Use the Read tool/); assert.equal((await readdir(cwd)).length, 1);
    child.stdout.write(event({ type: 'result', subtype: 'error', is_error: true }));
  });
  await assert.rejects(paper(cwd, fake, { imageData: 'data:image/png;base64,aGk=' }), /error/);
  assert.deepEqual(await readdir(cwd), []);
  await assert.rejects(paper(cwd, fake, { sessionId: 'bad' }), /session ID/);
});

test('Windows npm shim resolves its package entry without a shell', async (t) => {
  const cwd = await workspace(t); const root = path.join(cwd, 'node_modules', '@anthropic-ai', 'claude-code');
  await mkdir(root, { recursive: true }); await writeFile(path.join(root, 'package.json'), JSON.stringify({ bin: { claude: 'cli.js' } }));
  await writeFile(path.join(root, 'cli.js'), ''); await writeFile(path.join(cwd, 'claude.cmd'), '');
  assert.deepEqual(resolveClaudeLaunch({ command: 'claude', pathValue: cwd, appData: cwd, platform: 'win32' }), { command: process.execPath, args: [path.join(root, 'cli.js')] });
});


test('unterminated final JSON preserves split Unicode and emits missing final answer after commentary', async (t) => {
  const cwd = await workspace(t); const fake = fakeChild((child) => {
    child.stdout.write(event({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'comment' } } }));
    const bytes = Buffer.from(JSON.stringify(result('\u6700\u7d42\u7b54\u6848')));
    const split = bytes.indexOf(Buffer.from('\u6700')) + 1;
    child.stdout.write(bytes.subarray(0, split)); child.stdout.write(bytes.subarray(split)); child.emit('close', 0);
  });
  let deltas = ''; const output = await paper(cwd, fake, { onDelta: (s) => { deltas += s; } });
  assert.equal(output.text, '\u6700\u7d42\u7b54\u6848');
  assert.equal(deltas, 'comment\n\n\u6700\u7d42\u7b54\u6848');
});

test('billing and nested-session markers are removed regardless of case while network settings remain', async (t) => {
  const cwd = await workspace(t); const keys = ['anthropic_api_key', 'claudecode', 'claude_code_entrypoint', 'claude_code_simple', 'HTTP_PROXY'];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } });
  for (const key of keys) process.env[key] = 'test-value';
  const fake = fakeChild((child) => { child.stdout.write(event(result('ok'))); child.emit('close', 0); });
  await paper(cwd, fake);
  const env = fake.call.options.env;
  assert.equal(Object.keys(env).some((key) => /^(anthropic_api_key|claudecode|claude_code_entrypoint|claude_code_simple)$/i.test(key)), false);
  assert.equal(env.HTTP_PROXY, 'test-value');
});

test('safe error categorization keeps private result details out of errors', async (t) => {
  const cwd = await workspace(t); const fake = fakeChild((child) => child.stdout.write(event({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['rate limit private-secret'] })));
  await assert.rejects(paper(cwd, fake), (error) => /error_during_execution/.test(error.message) && /\u8acb\u7a0d\u5f8c\u518d\u8a66/.test(error.message) && !/private-secret/.test(error.message));
});

test('Windows npm package native bin launches directly', async (t) => {
  const cwd = await workspace(t); const root = path.join(cwd, 'node_modules', '@anthropic-ai', 'claude-code');
  await mkdir(path.join(root, 'bin'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ bin: { claude: 'bin/claude.exe' } }));
  await writeFile(path.join(root, 'bin', 'claude.exe'), '');
  assert.deepEqual(resolveClaudeLaunch({ command: 'claude', pathValue: cwd, platform: 'win32' }), { command: path.join(root, 'bin', 'claude.exe'), args: [] });
});

// Simulate a disconnected streaming response while Claude is still running.
test('closing the response terminates an active Claude process', async (t) => {
  const cwd = await workspace(t);
  const response = new EventEmitter(); response.writableEnded = false; response.destroyed = false;
  const requestAbort = abortOnResponseClose(response);
  const fake = fakeChild(() => response.emit('close'));
  try {
    await assert.rejects(paper(cwd, fake, { signal: requestAbort.signal }), /aborted/);
    assert.equal(fake.child.killed, true);
  } finally { requestAbort.dispose(); }
});

test('multiple images are readable during execution and all are cleaned up', async (t) => {
  const cwd = await workspace(t);
  for (const outcome of ['success', 'error', 'abort']) {
    const controller = new AbortController();
    const fake = fakeChild(async (child, input) => {
      assert.equal((input.match(/Use the Read tool/g) || []).length, 2);
      assert.equal((await readdir(cwd)).length, 2);
      if (outcome === 'abort') controller.abort();
      else { child.stdout.write(event(outcome === 'success' ? result('ok') : { type: 'result', subtype: 'error', is_error: true })); child.emit('close', 0); }
    });
    const run = paper(cwd, fake, { images: ['data:image/png;base64,YQ==', 'data:image/jpeg;base64,Yg=='], signal: controller.signal });
    if (outcome === 'success') await run;
    else await assert.rejects(run);
    assert.deepEqual(await readdir(cwd), []);
  }
});
