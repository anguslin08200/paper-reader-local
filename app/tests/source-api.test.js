import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

// Exercise the HTTP guard and persistent backfill in an isolated runtime without launching providers.
test('backfills and switches imported PDF sources through the API', async () => {
  const base = path.resolve('.local-check');
  await mkdir(base, { recursive: true });
  const runtime = await mkdtemp(path.join(base, 'source-api-'));
  const library = path.join(runtime, 'library');
  await mkdir(path.join(library, 'papers', 'paper'), { recursive: true });
  await writeFile(path.join(library, 'papers', 'paper', 'original.pdf'), '%PDF-1.4\n');
  await writeFile(path.join(library, 'index.json'), JSON.stringify({ folders: [], papers: [{ id: 'paper', fileName: 'paper_mono.pdf' }] }));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const server = spawn(process.execPath, ['src/server/index.js'], { env: { ...process.env, PORT: String(port), PAPER_READER_RUNTIME_DIR: runtime, PAPER_READER_ROOT: library }, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${url}/api/health`)).ok) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'server started');
    let index = JSON.parse(await readFile(path.join(library, 'index.json'), 'utf8'));
    assert.equal(index.papers[0].sourceKind, 'translated');
    assert.equal(index.papers[0].translatedVariant, 'chinese');
    let status = await (await fetch(`${url}/api/papers/paper/status`)).json();
    assert.equal(status.translation.outputs.original, false);
    assert.equal(status.translation.outputs.chinese, true);
    assert.equal((await fetch(`${url}/api/papers/paper/pdf?variant=chinese`)).status, 200);
    const guard = await fetch(`${url}/api/papers/paper/translate-pdf`, { method: 'POST' });
    assert.equal(guard.status, 400);
    assert.equal((await guard.json()).error, '此為已翻譯版，無需再翻譯');
    const patch = await fetch(`${url}/api/papers/paper/source`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceKind: 'original' }) });
    assert.equal(patch.status, 200);
    index = JSON.parse(await readFile(path.join(library, 'index.json'), 'utf8'));
    assert.equal(index.papers[0].sourceKind, 'original');
    status = await (await fetch(`${url}/api/papers/paper/status`)).json();
    assert.equal(status.translation.outputs.original, true);
    assert.equal(status.translation.outputs.chinese, false);
    // The reverse correction exposes the same uploaded bytes as the selected translated variant.
    const markTranslated = await fetch(`${url}/api/papers/paper/source`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceKind: 'translated', translatedVariant: 'bilingual' }) });
    assert.equal(markTranslated.status, 200);
    status = await (await fetch(`${url}/api/papers/paper/status`)).json();
    assert.deepEqual(status.translation.outputs, { original: false, chinese: false, bilingual: true });
    assert.equal((await fetch(`${url}/api/papers/paper/pdf?variant=bilingual`)).status, 200);
    assert.equal((await fetch(`${url}/api/papers/paper/translate-pdf`, { method: 'POST' })).status, 400);
  } finally {
    if (server.exitCode === null) {
      const exited = new Promise((resolve) => server.once('exit', resolve));
      server.kill();
      await exited;
    }
    await rm(runtime, { recursive: true, force: true });
  }
});
