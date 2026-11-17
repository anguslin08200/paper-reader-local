import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';

// Simulate child processes without executing a translation or using external services.
test('PDF translation lifecycle and output discovery', async () => {
  // Keep the complete fake translation lifecycle inside the isolated workspace.
  const checkRoot = path.resolve('.local-check');
  await mkdir(checkRoot, { recursive: true });
  const root = await mkdtemp(path.join(checkRoot, 'paper-pdf-'));
  process.env.PAPER_READER_ROOT = root;
  const { getPdfTranslationStatus, translatedPdfPath, startPdfTranslation } = await import('../src/server/pdf-translation.js');
  const script = path.join(root, 'translator.ps1');
  const settings = { pdfTranslation: { provider: 'Local', model: 'local-7b', scriptPath: script, effort: 'low', parallel: 8 } };
  const makePaper = async (id) => {
    const dir = path.join(root, 'papers', id);
    await mkdir(path.join(dir, 'translations'), { recursive: true });
    await writeFile(path.join(dir, 'original.pdf'), '%PDF-1.7\n');
    return dir;
  };
  const fakeChild = () => {
    const child = new EventEmitter();
    child.pid = 4321;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit('close', null);
    return child;
  };
  const waitFinal = async (id) => {
    // Wait for the final snapshot on disk as well as the in-memory state.
    for (let i = 0; i < 600; i++) {
      const state = JSON.parse(await readFile(path.join(root, 'papers', id, 'pdf-translation.json'), 'utf8'));
      if (state.status !== 'running') return state;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('job did not finish');
  };
  try {
    await writeFile(script, '# fake');
    const dir = await makePaper('discovery');
    const output = path.join(dir, 'translations');
    await writeFile(path.join(output, 'original.no_watermark.zh-TW.mono.pdf'), '%PDF-1.7\n');
    await writeFile(path.join(output, 'original.no_watermark.zh-TW.dual.pdf'), 'not a PDF');
    await writeFile(path.join(dir, 'pdf-translation.json'), JSON.stringify({ status: 'running', log: 'old progress' }));
    const status = await getPdfTranslationStatus('discovery');
    assert.equal(status.status, 'failed');
    assert.deepEqual(status.outputs, { original: true, chinese: true, bilingual: false });
    assert.match(await translatedPdfPath('discovery', 'chinese'), /\.mono\.pdf$/);
    assert.equal(await translatedPdfPath('discovery', 'bilingual'), null);
    assert.equal(await translatedPdfPath('discovery', '../original'), null);
    await assert.rejects(startPdfTranslation('discovery', { pdfTranslation: { provider: 'invalid' } }), /provider/);
    assert.match((await getPdfTranslationStatus('discovery')).error, /provider/);
    await assert.rejects(getPdfTranslationStatus('../outside'), /Invalid paper ID/);

    const successDir = await makePaper('success');
    const successChild = fakeChild();
    let launch;
    const running = await startPdfTranslation('success', settings, { spawnProcess: (...args) => { launch = args; return successChild; } });
    assert.equal(running.status, 'running');
    assert.equal(launch[0], 'powershell.exe');
    assert.deepEqual(launch[1].slice(-2), ['-Model', 'local-7b']);
    assert.equal(launch[2].cwd, successDir);
    assert.equal(launch[2].env.PYTHONDONTWRITEBYTECODE, '1');
    assert.equal(launch[2].env.PYTHONIOENCODING, 'utf-8');
    assert.equal(launch[2].env.PYTHONUNBUFFERED, '1');
    successChild.stdout.emit('data', Buffer.from('translating ' + 'x'.repeat(18000)));
    assert.equal((await getPdfTranslationStatus('success')).log.length, 16000);
    await assert.rejects(startPdfTranslation('success', settings), /已有/);
    await writeFile(path.join(successDir, 'translations', 'original.zh-TW.mono.pdf'), '%PDF-1.7\n');
    await writeFile(path.join(successDir, 'translations', 'original.zh-TW.dual.pdf'), '%PDF-1.7\n');
    successChild.emit('close', 0);
    assert.equal((await waitFinal('success')).status, 'completed');
    assert.deepEqual((await getPdfTranslationStatus('success')).outputs, { original: true, chinese: true, bilingual: true });

    // Existing PDFs cannot make a new run with no output look successful.
    const staleDir = await makePaper('stale');
    await writeFile(path.join(staleDir, 'translations', 'original.zh-TW.mono.pdf'), '%PDF-1.7\n');
    await writeFile(path.join(staleDir, 'translations', 'original.zh-TW.dual.pdf'), '%PDF-1.7\n');
    const staleChild = fakeChild();
    await startPdfTranslation('stale', settings, { spawnProcess: () => staleChild });
    staleChild.emit('close', 0);
    assert.equal((await waitFinal('stale')).status, 'failed');

    await makePaper('failure');
    const failedChild = fakeChild();
    await startPdfTranslation('failure', settings, { spawnProcess: () => failedChild });
    failedChild.stderr.emit('data', Buffer.from('failure details'));
    failedChild.emit('close', 2);
    const failed = await waitFinal('failure');
    assert.match(failed.error, /2/);
    assert.match(failed.log, /failure details/);

    await makePaper('spawn-error');
    const errorChild = fakeChild();
    await startPdfTranslation('spawn-error', settings, { spawnProcess: () => errorChild });
    errorChild.emit('error', new Error('spawn failed'));
    errorChild.emit('close', -1);
    assert.match((await waitFinal('spawn-error')).error, /spawn failed/);
    await makePaper('sync-error');
    await assert.rejects(startPdfTranslation('sync-error', settings, { spawnProcess: () => { throw new Error('sync spawn failed'); } }), /sync spawn failed/);
    assert.match((await getPdfTranslationStatus('sync-error')).error, /sync spawn failed/);

    await makePaper('timeout');
    const timedChild = fakeChild();
    let terminated = null;
    await startPdfTranslation('timeout', settings, { spawnProcess: () => timedChild, timeoutMs: 20, terminateProcess: (child) => { terminated = child; child.emit('close', null); } });
    assert.match((await waitFinal('timeout')).error, /超時/);
    assert.equal(terminated, timedChild);
  } finally {
    delete process.env.PAPER_READER_ROOT;
    await rm(root, { recursive: true, force: true });
  }
});


// Retry only transient Windows lock errors, keeping failures bounded and visible.
test('status replacement retries transient locks and propagates other failures', async () => {
  const { replaceStatusFile } = await import('../src/server/pdf-translation.js');
  let attempts = 0;
  const delays = [];
  await replaceStatusFile('temp', 'target', async () => {
    attempts++;
    if (attempts < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
  }, async (ms) => delays.push(ms));
  assert.equal(attempts, 3);
  assert.equal(delays.length, 2);
  assert.ok(delays.every((delay) => delay >= 10 && delay <= 25));
  attempts = 0;
  await assert.rejects(replaceStatusFile('temp', 'target', async () => {
    attempts++;
    throw Object.assign(new Error('bad path'), { code: 'ENOENT' });
  }, async () => {}), /bad path/);
  assert.equal(attempts, 1);
  attempts = 0;
  await assert.rejects(replaceStatusFile('temp', 'target', async () => {
    attempts++;
    throw Object.assign(new Error('still locked'), { code: 'EBUSY' });
  }, async () => {}), /still locked/);
  assert.equal(attempts, 50);
});
