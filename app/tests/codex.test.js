import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServer, runCodexPaperAgent, buildPaperInput, paperDeveloperInstructions, normalizeCodexModels, listCodexModels } from '../src/server/codex.js';
import { getPiStatus, resolvePiLaunch, runPaperAgent } from '../src/server/pi.js';
import { abortOnResponseClose } from '../src/server/response-abort.js';

// A protocol-level fake exercises real newline framing and RPC ordering without any inference calls.
function fakeServer(onRequest = () => {}) {
  const requests = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  const send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(String(chunk));
      requests.push(message);
      queueMicrotask(() => {
        if (message.method === 'initialize') send({ id: message.id, result: {} });
        else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'paper-thread' } } });
        else onRequest(message, { send, child });
      });
      callback();
    },
  });
  return { child, send, requests, spawnProcess: () => child };
}

async function makeBridge(t, onRequest) {
  const fake = fakeServer(onRequest);
  const bridge = new CodexAppServer({ cwd: '.', spawnProcess: fake.spawnProcess, command: 'fake-codex', requestTimeout: 500 });
  t.after(() => bridge.close());
  await bridge.connect();
  return { bridge, ...fake };
}

test('Codex streams split JSON lines, buffers deltas, and supplies read-only paper thread options', async (t) => {
  const { bridge, requests, child } = await makeBridge(t, (request, { send, child }) => {
    if (request.method !== 'turn/start') return;
    send({ id: request.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
    const line = JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'paper-thread', turnId: 'turn-1', itemId: 'answer', delta: '繁體' } });
    child.stdout.write('diagnostic output\n');
    child.stdout.write(line.slice(0, 25));
    child.stdout.write(`${line.slice(25)}\n`);
    send({ method: 'item/agentMessage/delta', params: { threadId: 'other-thread', delta: 'ignore' } });
    send({ method: 'item/completed', params: { threadId: 'paper-thread', item: { id: 'answer', type: 'agentMessage', text: '繁體回答' } } });
    send({ method: 'turn/completed', params: { threadId: 'paper-thread', turn: { id: 'turn-1', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: '繁體回答' }] } } });
  });
  const deltas = [];
  const text = await bridge.turn({ developerInstructions: paperDeveloperInstructions(), input: [{ type: 'text', text: '問題' }], model: 'chosen-model', effort: 'low', onDelta: (delta) => deltas.push(delta) });
  assert.equal(text, '繁體回答');
  assert.deepEqual(deltas, ['繁體', '回答']);
  const thread = requests.find((request) => request.method === 'thread/start').params;
  assert.equal(thread.sandbox, 'read-only');
  assert.equal(thread.approvalPolicy, 'never');
  assert.equal(thread.ephemeral, true);
  assert.equal(thread.config.web_search, 'disabled');
  assert.match(thread.developerInstructions, /parsed\/result\.md/);
  assert.match(thread.developerInstructions, /只有來源明確提供頁碼/);
  assert.equal(requests.find((request) => request.method === 'turn/start').params.effort, 'low');
  bridge.close();
  assert.equal(child.killed, true);
});

for (const [name, notification, expected] of [
  ['fatal error', { method: 'error', params: { willRetry: false, error: { message: 'terminal network failure' } } }, /terminal network failure/],
  ['systemError', { method: 'thread/status/changed', params: { status: { type: 'systemError' } } }, /系統錯誤/],
  ['failed turn', { method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'invalid prompt' } } } }, /invalid prompt/],
  ['interrupted turn', { method: 'turn/completed', params: { turn: { status: 'interrupted' } } }, /停止/],
]) {
  test(`Codex rejects ${name} without waiting for another event`, async (t) => {
    const { bridge } = await makeBridge(t, (request, { send }) => {
      if (request.method !== 'turn/start') return;
      send({ id: request.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
      send(notification);
    });
    await assert.rejects(bridge.turn({ input: [] }), expected);
  });
}

test('Codex ignores retryable errors and accepts a final item without streaming deltas', async (t) => {
  const { bridge } = await makeBridge(t, (request, { send }) => {
    if (request.method !== 'turn/start') return;
    send({ method: 'error', params: { willRetry: true, error: { message: 'retrying private-diagnostic-token' } } });
    send({ id: request.id, result: { turn: { id: 'turn-1', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'complete' }] } } });
  });
  let output = '';
  const statuses = [];
  assert.equal(await bridge.turn({ input: [], onDelta: (delta) => { output += delta; }, onStatus: (status) => statuses.push(status) }), 'complete');
  assert.equal(output, 'complete');
  assert.deepEqual(statuses, ['Codex 連線暫時不穩，正在重試…']);
  assert.doesNotMatch(statuses.join(''), /private-diagnostic-token/);
});

for (const detail of ['Reconnecting... waiting for network', 'Reconnecting... waitingfornetwork']) {
  test(`Codex fails promptly when retry is parked: ${detail}`, async (t) => {
    const { bridge } = await makeBridge(t, (request, { send, child }) => {
      if (request.method !== 'turn/start') return;
      send({ id: request.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
      child.stderr.write('private stderr diagnostic');
      // Deliberately omit turn/completed: offline status must reject the pending turn on its own.
      send({ method: 'error', params: { threadId: 'paper-thread', willRetry: true, error: { message: `${detail}; private-diagnostic-token` } } });
    });
    const statuses = [];
    const message = 'Codex 無法連線服務，請檢查網路後重試。';
    await assert.rejects(bridge.turn({ input: [], onStatus: (status) => statuses.push(status) }), { message });
    assert.deepEqual(statuses, [message]);
    assert.doesNotMatch(statuses.join(''), /private|stderr/);
    assert.equal(bridge.active, null);
  });
}

test('Codex process exit rejects pending work and closed requests promptly', async (t) => {
  const { bridge } = await makeBridge(t, (request, { child }) => {
    if (request.method === 'turn/start') child.emit('exit', 1);
  });
  await assert.rejects(bridge.turn({ input: [] }), /程式已結束/);
  await assert.rejects(bridge.request('model/list'), /連線已關閉/);
});

test('Codex RPC timeout releases the process', async (t) => {
  const { bridge, child } = await makeBridge(t, () => {});
  bridge.requestTimeout = 10;
  await assert.rejects(bridge.request('model/list'), /等待逾時/);
  assert.equal(child.killed, true);
});

test('Codex RPC errors reject the matching call', async (t) => {
  const { bridge } = await makeBridge(t, (request, { send }) => {
    if (request.method === 'turn/start') send({ id: request.id, error: { code: -32602, message: 'unsupported model' } });
  });
  await assert.rejects(bridge.turn({ input: [] }), /unsupported model/);
});

test('paper tasks retain configured templates and previous answer for an explicit follow-up', () => {
  const settings = { prompts: { question: 'editable question template', summary: 'editable summary template' } };
  const input = buildPaperInput({ question: 'follow-up', task: 'question', context: { paper: { title: 'Paper' }, page: 3, previousAnswer: 'previous answer' } }, settings);
  assert.match(input, /editable question template/);
  assert.match(input, /previous answer/);
  assert.match(input, /目前檢視頁碼（僅供定位）：3/);
  assert.match(buildPaperInput({ task: 'summary' }, settings), /editable summary template/);
});

test('model response maps CLI fields and hides hidden models', () => {
  assert.deepEqual(normalizeCodexModels({ data: [{ model: 'available', displayName: 'Available', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low', inputModalities: ['text', 'image'] }, { model: 'hidden', hidden: true }] }), [{
    id: 'available', name: 'Available', description: '', isDefault: true,
    inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low',
  }]);
  assert.deepEqual(normalizeCodexModels({}), []);
});

test('model/list follows cursors without inference and always closes its own process', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'paper-codex-models-'));
  const fake = fakeServer((request, { send }) => {
    if (request.method !== 'model/list') return;
    send({ id: request.id, result: request.params.cursor
      ? { data: [{ model: 'second' }], nextCursor: null }
      : { data: [{ model: 'first', isDefault: true }], nextCursor: 'page-2' } });
  });
  try {
    const result = await listCodexModels({ cwd, spawnProcess: fake.spawnProcess, command: 'fake-codex' });
    assert.deepEqual(result.models.map((model) => model.id), ['first', 'second']);
    assert.equal(result.defaultModel, 'first');
    assert.equal(fake.requests.some((request) => request.method === 'turn/start'), false);
    assert.equal(fake.child.killed, true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('abort cancels a pending request and terminates only its own Codex process', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'paper-codex-abort-'));
  const controller = new AbortController();
  const fake = fakeServer((request) => {
    if (request.method === 'model/list') controller.abort();
  });
  try {
    await assert.rejects(listCodexModels({ cwd, signal: controller.signal, spawnProcess: fake.spawnProcess, command: 'fake-codex' }), /停止/);
    assert.equal(fake.child.killed, true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('overall deadline cancels a hanging request before the RPC deadline', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'paper-codex-timeout-'));
  const fake = fakeServer();
  try {
    await assert.rejects(listCodexModels({ cwd, timeoutMs: 10, requestTimeout: 1000, spawnProcess: fake.spawnProcess, command: 'fake-codex' }), /回應逾時/);
    assert.equal(fake.child.killed, true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('Windows Pi npm shim resolves to the installed package bin through Node without a shell', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'paper-pi-launch-'));
  const packageRoot = path.join(cwd, 'node_modules', '@earendil-works', 'pi-coding-agent');
  const entry = path.join(packageRoot, 'dist', 'cli.js');
  try {
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ bin: { pi: 'dist/cli.js' } }));
    await writeFile(entry, '// Fake installed CLI entry; this test never starts an assistant.');
    await writeFile(path.join(cwd, 'pi.cmd'), '@echo off');
    const options = { platform: 'win32', pathValue: cwd, appData: cwd, command: 'pi' };
    assert.deepEqual(resolvePiLaunch(options), { command: process.execPath, args: [entry] });
    assert.deepEqual(resolvePiLaunch({ ...options, command: path.join(cwd, 'pi.cmd') }), { command: process.execPath, args: [entry] });
    assert.deepEqual(resolvePiLaunch({ ...options, command: entry }), { command: process.execPath, args: [entry] });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('Pi status reads only Pi credentials, honors PI_CODING_AGENT_DIR, and never returns secrets', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'paper-pi-status-'));
  const previousDirectory = process.env.PI_CODING_AGENT_DIR;
  const entry = path.join(cwd, 'fake-cli.js');
  const authPath = path.join(cwd, 'auth.json');
  const launchOptions = { command: entry, pathValue: '', appData: cwd, platform: 'win32' };
  try {
    await writeFile(entry, '// Fake CLI entry for the availability check.');
    process.env.PI_CODING_AGENT_DIR = cwd;
    const original = JSON.stringify({ anthropic: { type: 'oauth', access: 'private-access', refresh: 'private-refresh', expires: 0 } });
    await writeFile(authPath, original);
    const status = await getPiStatus({ launchOptions });
    assert.deepEqual(status, { provider: 'pi', available: true, loggedIn: true });
    assert.doesNotMatch(JSON.stringify(status), /private|access|refresh|anthropic/);
    assert.equal(await readFile(authPath, 'utf8'), original);
    await writeFile(authPath, JSON.stringify({ provider: { type: 'api_key', key: 'private-key' } }));
    assert.equal((await getPiStatus({ launchOptions })).loggedIn, true);
    await writeFile(authPath, JSON.stringify({ tokens: { access_token: 'codex-only-token' } }));
    assert.equal((await getPiStatus({ launchOptions })).loggedIn, false);
    await writeFile(authPath, 'invalid JSON');
    assert.equal((await getPiStatus({ launchOptions })).loggedIn, false);
    assert.equal((await getPiStatus({ agentDirectory: cwd, launchOptions: { command: 'missing-test-cli', pathValue: cwd, appData: cwd } })).available, false);
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDirectory;
    await rm(cwd, { recursive: true, force: true });
  }
});

// The same response-close signal used by the HTTP handler must reach the owned process.
test('closing the response terminates an active Codex process', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'paper-codex-close-'));
  const response = new EventEmitter(); response.writableEnded = false; response.destroyed = false;
  const requestAbort = abortOnResponseClose(response);
  const fake = fakeServer((request) => { if (request.method === 'model/list') response.emit('close'); });
  try {
    await assert.rejects(listCodexModels({ cwd, signal: requestAbort.signal, spawnProcess: fake.spawnProcess, command: 'fake-codex' }));
    assert.equal(fake.child.killed, true);
  } finally { requestAbort.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test('response close ignores completed responses and catches already destroyed sockets', () => {
  const complete = new EventEmitter(); complete.writableEnded = true; complete.destroyed = false;
  const finished = abortOnResponseClose(complete); complete.emit('close');
  assert.equal(finished.signal.aborted, false); finished.dispose();
  const closed = new EventEmitter(); closed.writableEnded = false; closed.destroyed = true;
  const disconnected = abortOnResponseClose(closed);
  assert.equal(disconnected.signal.aborted, true); disconnected.dispose();
});

// Exercise the real provider framing while a fake app server inspects temporary image files.
test('Codex forwards multiple local images and removes them on success, error, and abort', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'codex-images-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const images = ['data:image/png;base64,YQ==', 'data:image/jpeg;base64,Yg=='];
  for (const outcome of ['success', 'error', 'abort']) {
    const controller = new AbortController();
    let received;
    let contents;
    const fake = fakeServer((request, { send }) => {
      if (request.method !== 'turn/start') return;
      received = request.params.input.filter((item) => item.type === 'localImage');
      Promise.all(received.map((item) => readFile(item.path, 'utf8'))).then((values) => {
        contents = values;
        if (outcome === 'abort') controller.abort();
        else send({ id: request.id, result: { turn: outcome === 'success' ? { id: 't', status: 'completed', items: [{ id: 'a', type: 'agentMessage', text: 'ok' }] } : { id: 't', status: 'failed', error: { message: 'fake failure' } } } });
      });
    });
    const run = runCodexPaperAgent({ cwd, context: { paper: { id: 'paper' } }, images, signal: controller.signal, bridgeOptions: { spawnProcess: fake.spawnProcess, command: 'fake' } }, { agent: {}, prompts: {} });
    if (outcome === 'success') assert.equal(await run, 'ok');
    else await assert.rejects(run);
    assert.equal(received.length, 2);
    assert.deepEqual(contents, ['a', 'b']);
    assert.deepEqual(await readdir(cwd), []);
  }
});

// The Pi stub reads the actual @paths while the request owns them; no CLI is launched.
test('Pi passes multiple image paths and cleans up after success, failure, and cancellation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const promptDirectory = path.join(root, 'prompts');
  const templateDirectory = path.join(root, 'templates');
  for (const outcome of ['success', 'error', 'abort']) {
    const controller = new AbortController();
    let contents;
    let paths;
    const runPi = async (_settings, args, _onDelta, options) => {
      paths = args.filter((item) => item.startsWith('@')).map((item) => item.slice(1));
      contents = await Promise.all(paths.map((file) => readFile(file, 'utf8')));
      if (outcome === 'abort') controller.abort();
      if (options.signal.aborted || outcome === 'error') throw new Error('fake stop');
    };
    const run = runPaperAgent({ question: 'Q', context: { paper: { id: 'paper' } }, images: ['data:image/png;base64,YQ==', 'data:image/jpeg;base64,Yg=='], signal: controller.signal }, { settings: { agent: { provider: 'pi', thinking: 'off' }, prompts: {} }, promptDirectory, templateDirectory, runPi });
    if (outcome === 'success') await run;
    else await assert.rejects(run);
    assert.equal(paths.length, 3);
    assert.deepEqual(contents.slice(1), ['a', 'b']);
    assert.ok(paths[2].endsWith('.jpg'));
    assert.deepEqual(await readdir(promptDirectory), []);
  }
});
