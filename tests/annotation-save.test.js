import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { annotatedFileName, normalizeExportDirectory, resolveExportPath, saveAnnotatedCopy, readSavedAnnotations } from '../src/server/annotation-save.js';
import { mergeSettings, publicSettings } from '../src/server/settings.js';

// All save/security fixtures live under the project, never in the user's export folder.
async function fixture(run) {
  const base = path.resolve('.local-check');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'annotation-save-'));
  try { await run(root); }
  finally {
    assert.equal(path.dirname(root), base);
    await rm(root, { recursive: true, force: true });
  }
}

test('export settings use an absolute default and retain a custom folder', () => {
  assert.ok(path.isAbsolute(mergeSettings().exportDirectory));
  const directory = path.resolve('.local-check', 'exports');
  assert.equal(publicSettings({ exportDirectory: directory }).exportDirectory, directory);
  for (const value of ['../elsewhere', '', 'C:\\bad\u0000path', '\\\\?\\C:\\exports']) assert.throws(() => normalizeExportDirectory(value), /路徑|資料夾/);
});

test('export filenames remove path and Windows reserved characters', () => {
  assert.equal(annotatedFileName('../../a:b?<>|'), '.._.._a_b_____標註.pdf');
  assert.equal(annotatedFileName('CON'), 'paper_CON_標註.pdf');
  assert.ok(annotatedFileName('x'.repeat(200)).length <= 127);
});

test('export paths reject traversal, siblings, subdirectories and non-PDF targets', async () => fixture(async (root) => {
  const directory = path.join(root, 'exports');
  await mkdir(directory);
  const target = path.join(directory, '正常_標註.pdf');
  assert.equal(await resolveExportPath(directory, target), target);
  for (const value of [path.join(root, 'outside.pdf'), path.join(directory, '..', 'outside.pdf'), path.join(`${directory}-other`, 'file.pdf'), path.join(directory, 'nested', 'file.pdf'), path.join(directory, 'command.exe'), directory]) {
    await assert.rejects(resolveExportPath(directory, value), /資料夾內/);
  }
  await assert.rejects(resolveExportPath(directory, target, { mustExist: true }), { code: 'ENOENT' });
  await writeFile(target, 'pdf');
  assert.equal(await resolveExportPath(directory, target, { mustExist: true }), target);
  // A junction inside the export root must not allow a nested path to escape the boundary.
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, path.join(directory, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveExportPath(directory, path.join(directory, 'link', 'file.pdf')), /資料夾內/);
  await symlink(outside, path.join(directory, 'alias.pdf'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveExportPath(directory, path.join(directory, 'alias.pdf')), /連結/);
  await assert.rejects(resolveExportPath(directory, path.join(directory, 'file:stream.pdf')), /名稱/);
}));

test('save writes both copies, retains a backup and records the exact saved snapshot', async () => fixture(async (root) => {
  const directory = path.join(root, 'exports');
  const paperDirectory = path.join(root, 'paper');
  await mkdir(paperDirectory);
  await writeFile(path.join(paperDirectory, 'original.pdf'), 'original');
  const annotations = [{ id: 'h1', variant: 'original', text: 'test' }];
  const options = { directory, paperDirectory, title: '測試論文', variant: 'original', annotations, written: 1 };
  const first = await saveAnnotatedCopy({ ...options, bytes: Buffer.from('first') });
  const second = await saveAnnotatedCopy({ ...options, bytes: Buffer.from('second'), annotations: [] });
  assert.equal(await readFile(second.path, 'utf8'), 'second');
  assert.equal(await readFile(second.internalPath, 'utf8'), 'second');
  assert.equal(await readFile(first.path.replace(/\.pdf$/, '.bak.pdf'), 'utf8'), 'first');
  assert.equal(await readFile(path.join(paperDirectory, 'original.pdf'), 'utf8'), 'original');
  assert.deepEqual((await readSavedAnnotations(paperDirectory)).original, []);
  await assert.rejects(saveAnnotatedCopy({ ...options, variant: '../original', bytes: Buffer.from('bad') }), /版本/);
}));

test('concurrent saves serialize the previous-version backup', async () => fixture(async (root) => {
  const paperDirectory = path.join(root, 'paper');
  await mkdir(paperDirectory);
  const options = { directory: path.join(root, 'exports'), paperDirectory, title: 'Concurrent', variant: 'original', annotations: [], written: 0 };
  const results = await Promise.all(['one', 'two', 'three'].map((text) => saveAnnotatedCopy({ ...options, bytes: Buffer.from(text) })));
  // Filesystem scheduling may reorder requests before the lock; the backup must still be prior data.
  const current = await readFile(results[2].path, 'utf8');
  const backup = await readFile(results[2].path.replace(/\.pdf$/, '.bak.pdf'), 'utf8');
  assert.ok(['one', 'two', 'three'].includes(current));
  assert.ok(['one', 'two', 'three'].includes(backup));
  assert.notEqual(current, backup);
  assert.equal(await readFile(results[2].internalPath, 'utf8'), current);
}));
