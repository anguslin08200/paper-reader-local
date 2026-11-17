import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractTtcFont, ANNOTATION_FONTS } from '../src/server/annotation-fonts.js';

test('font catalogue includes the reader families and rejects malformed TTC indices', () => {
  assert.equal(Object.keys(ANNOTATION_FONTS).length, 9);
  assert.ok(ANNOTATION_FONTS['Microsoft JhengHei'].includes('msjh.ttc'));
  const malformed = Buffer.alloc(16); malformed.write('ttcf'); malformed.writeUInt32BE(1, 8);
  assert.throws(() => extractTtcFont(malformed, 2), /index/);
  malformed.writeUInt32BE(200, 12);
  assert.throws(() => extractTtcFont(malformed), /directory/);
  assert.deepEqual(extractTtcFont(Buffer.from('OTTO-font')), Buffer.from('OTTO-font'));
});

test('extract Windows JhengHei TTC into a standalone font with correct table offsets/checksum', async (t) => {
  let collection;
  try { collection = await readFile('C:/Windows/Fonts/msjh.ttc'); } catch (error) {
    if (error.code === 'ENOENT') return t.skip('Windows JhengHei font not installed');
    throw error;
  }
  const font = extractTtcFont(collection);
  assert.notEqual(font.toString('ascii', 0, 4), 'ttcf');
  const count = font.readUInt16BE(4);
  assert.ok(count > 5);
  let foundCmap = false;
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    const offset = font.readUInt32BE(record + 8); const length = font.readUInt32BE(record + 12);
    assert.ok(offset >= 12 + count * 16 && offset + length <= font.length);
    if (font.toString('ascii', record, record + 4) === 'cmap') foundCmap = true;
  }
  assert.equal(foundCmap, true);
  let checksum = 0;
  for (let offset = 0; offset < font.length; offset += 4) checksum = (checksum + font.readUInt32BE(offset)) >>> 0;
  assert.equal(checksum, 0xB1B0AFBA);
});
