import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

test('background parsing preserves readable originals and the previous index on failure, then retries from cache', async () => {
  // A missing executable exercises the real failure path without launching a tool or touching user data.
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'paper-parse-jobs-'));
  process.env.PAPER_READER_RUNTIME_DIR = runtime;
  process.env.PAPER_READER_ROOT = path.join(runtime, 'library');
  try {
    const { paperDirectory } = await import('../src/server/store.js');
    const { startParseJob, getParseStatus, isParsing } = await import('../src/server/parse-jobs.js');
    const directory = paperDirectory('paper-test');
    const pdf = Buffer.from('%PDF-1.7 original');
    const cache = path.join(runtime, 'cache');
    await mkdir(path.join(directory, 'parsed/images'), { recursive: true });
    await writeFile(path.join(directory, 'original.pdf'), pdf);
    await writeFile(path.join(directory, 'parsed/result.md'), 'previous extraction');
    await writeFile(path.join(directory, 'parsed/images/old.png'), 'previous image');
    await writeFile(path.join(directory, 'rag-index.json'), '{"sections":[]}');
    await writeFile(path.join(runtime, 'settings.json'), JSON.stringify({ rag: {
      mineruExecutable: path.join(runtime, 'missing.exe'), mineruCacheDirectory: cache,
    } }));
    assert.equal((await startParseJob('paper-test')).status, 'running');
    assert.equal(isParsing('paper-test'), true);
    for (let attempt = 0; isParsing('paper-test') && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await getParseStatus('paper-test')).status, 'failed');
    assert.deepEqual(await readFile(path.join(directory, 'original.pdf')), pdf);
    assert.equal(await readFile(path.join(directory, 'parsed/images/old.png'), 'utf8'), 'previous image');
    assert.equal(await readFile(path.join(directory, 'rag-index.json'), 'utf8'), '{"sections":[]}');

    // A real cache fixture validates the staged extraction/index replacement on retry.
    const sha = createHash('sha256').update(pdf).digest('hex');
    await mkdir(path.join(cache, sha), { recursive: true });
    await writeFile(path.join(cache, sha, 'cache.json'), JSON.stringify({ sha, files: [] }));
    await writeFile(path.join(cache, sha, 'markdown.md'), '# Abstract\nA selective state space model.');
    await startParseJob('paper-test');
    for (let attempt = 0; isParsing('paper-test') && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    const state = await getParseStatus('paper-test');
    assert.equal(state.status, 'completed');
    assert.equal(state.sha256, sha);
    assert.deepEqual(await readFile(path.join(directory, 'original.pdf')), pdf);
    assert.match(await readFile(path.join(directory, 'parsed/result.md'), 'utf8'), /selective state/);
    assert.equal(JSON.parse(await readFile(path.join(directory, 'rag-index.json'))).retrievalProvider, 'bm25');
  } finally {
    delete process.env.PAPER_READER_RUNTIME_DIR;
    delete process.env.PAPER_READER_ROOT;
    await rm(runtime, { recursive: true, force: true });
  }
});
