import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyHistory, recordChange, stepHistory, sameAnnotation } from '../src/shared/annotation-history.js';

test('annotation history restores snapshots and clears redo on a new edit', () => {
  const item = { id: 'a', type: 'text', text: 'first' };
  let history = recordChange(emptyHistory(), null, item);
  history = recordChange(history, item, { ...item, text: 'second' });
  let result = stepHistory(history, 'undo');
  assert.equal(result.change.before.text, 'first');
  result = stepHistory(result.history, 'undo');
  assert.equal(result.change.before, null);
  result = stepHistory(result.history, 'redo');
  assert.equal(result.change.after.id, 'a');
  history = recordChange(result.history, item, null);
  assert.equal(history.redo.length, 0);
  assert.equal(stepHistory(emptyHistory(), 'undo').change, null);
});

test('history snapshots remain stable when the editor mutates an annotation', () => {
  const item = { id: 'a', text: 'original', rects: [{ x: 0.2 }] };
  const history = recordChange(emptyHistory(), null, item);
  item.text = 'changed'; item.rects[0].x = 0.7;
  assert.equal(history.undo[0].after.text, 'original');
  assert.equal(history.undo[0].after.rects[0].x, 0.2);
});

test('timestamps, legacy type and editor bookkeeping do not add no-op undo entries', () => {
  const before = { id: 'h', text: 'unchanged', updatedAt: 'old' };
  const after = { text: 'unchanged', type: 'highlight', id: 'h', updatedAt: 'new', _original: before };
  const history = emptyHistory();
  assert.ok(sameAnnotation(before, after));
  assert.equal(recordChange(history, before, after), history);
  assert.equal(sameAnnotation(before, { ...after, text: 'edited' }), false);
  assert.equal(sameAnnotation(null, after), false);
});
