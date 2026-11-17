import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { PDFDocument, PDFName } from 'pdf-lib';

// Exercise save and undo recreation through HTTP without a provider or the real runtime.
test('annotation API preserves IDs, filters variants, saves backups and protects originals', async () => {
  const base = path.resolve('.local-check');
  await mkdir(base, { recursive: true });
  const runtime = await mkdtemp(path.join(base, 'annotation-api-'));
  const library = path.join(runtime, 'library');
  const directory = path.join(library, 'papers', 'paper');
  const exports = path.join(runtime, 'exports');
  await mkdir(directory, { recursive: true });
  const pdf = await PDFDocument.create(); pdf.addPage([600, 800]);
  const original = Buffer.from(await pdf.save());
  await writeFile(path.join(directory, 'original.pdf'), original);
  await writeFile(path.join(library, 'index.json'), JSON.stringify({ folders: [], papers: [{ id: 'paper', title: 'API 匯出測試', sourceKind: 'original' }] }));
  await writeFile(path.join(runtime, 'settings.json'), JSON.stringify({ exportDirectory: exports }));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  assert.notEqual(port, 3080);
  const server = spawn(process.execPath, ['src/server/index.js'], { env: { ...process.env, PORT: String(port), PAPER_READER_RUNTIME_DIR: runtime, PAPER_READER_ROOT: library }, stdio: 'ignore', windowsHide: true });
  const url = `http://127.0.0.1:${port}`;
  async function request(route, method = 'GET', body) {
    return fetch(`${url}/api/papers/paper/${route}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${url}/api/health`)).ok) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready);
    const item = { id: 'restored-id', page: 1, variant: 'original', rects: [{ x: .1, y: .1, w: .2, h: .03 }], color: 'yellow', text: '重點', note: '注解' };
    let response = await request('annotations', 'POST', item);
    assert.equal(response.status, 201);
    assert.equal((await response.json()).id, item.id);
    assert.equal((await request('annotations', 'POST', item)).status, 400);
    assert.equal((await request('annotations', 'POST', { ...item, id: '../../bad' })).status, 400);
    assert.equal((await request('annotations/restored-id', 'DELETE')).status, 200);
    assert.equal((await request('annotations', 'POST', item)).status, 201);
    assert.equal((await request('annotations', 'POST', { ...item, id: 'other-variant', variant: 'chinese' })).status, 201);
    response = await request('save-annotated', 'POST', { variant: 'original' });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.written, 1);
    assert.equal(saved.savedAnnotations.length, 1);
    const first = await readFile(saved.path);
    assert.deepEqual(first, await readFile(saved.internalPath));
    let reopened = await PDFDocument.load(first);
    assert.equal(reopened.getPages()[0].node.lookup(PDFName.of('Annots')).size(), 2);
    assert.deepEqual(await readFile(path.join(directory, 'original.pdf')), original);
    response = await request('annotations/restored-id', 'PATCH', { note: '第二版', color: 'blue' });
    assert.equal(response.status, 200);
    const list = await (await request('annotations')).json();
    assert.equal(list.savedAnnotations.original[0].note, '注解');
    assert.equal(list.annotations.find((annotation) => annotation.id === item.id).note, '第二版');
    assert.equal((await request('save-annotated', 'POST', { variant: 'original' })).status, 200);
    assert.deepEqual(await readFile(saved.path.replace(/\.pdf$/, '.bak.pdf')), first);
    response = await request('export-annotated?variant=original');
    assert.equal(response.status, 200);
    reopened = await PDFDocument.load(await response.arrayBuffer());
    assert.equal(reopened.getPages()[0].node.lookup(PDFName.of('Annots')).size(), 2);
    assert.equal((await request('save-annotated', 'POST', { variant: '../original' })).status, 400);
    assert.equal((await request('export-annotated?variant=invalid')).status, 400);
    // Invalid Explorer requests must be rejected before spawning any process.
    response = await request('open-export-folder', 'POST', { path: path.join(runtime, 'outside.pdf') });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /資料夾內/);
  } finally {
    if (server.exitCode === null) { const exited = new Promise((resolve) => server.once('exit', resolve)); server.kill(); await exited; }
    assert.equal(path.dirname(runtime), base);
    await rm(runtime, { recursive: true, force: true });
  }
});
