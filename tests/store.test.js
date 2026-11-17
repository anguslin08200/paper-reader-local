import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('concurrent imports and position autosaves retain every library record', async () => {
  // Exercise a real asynchronous read/update race against an isolated library.
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-store-'));
  process.env.PAPER_READER_ROOT = root;
  try {
    const { ensureStore, mutateIndex, readIndex } = await import('../src/server/store.js');
    await ensureStore();
    await mutateIndex((index) => { index.papers.push({ id: 'reading', currentPage: 1 }); });
    await Promise.all(Array.from({ length: 20 }, (_, index) => mutateIndex(async (library) => {
      await new Promise((resolve) => setImmediate(resolve));
      library.papers.push({ id: `import-${index}` });
      library.papers.find((paper) => paper.id === 'reading').currentPage += 1;
    })));
    const library = await readIndex();
    assert.equal(library.papers.length, 21);
    assert.equal(library.papers.find((paper) => paper.id === 'reading').currentPage, 21);
  } finally {
    delete process.env.PAPER_READER_ROOT;
    await rm(root, { recursive: true, force: true });
  }
});
