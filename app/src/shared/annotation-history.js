// History stores complete snapshots so deleted annotations can be recreated with their IDs.
export const emptyHistory = () => ({ undo: [], redo: [] });
// Timestamps and editor bookkeeping do not create a visible undoable change.
export function sameAnnotation(before, after) {
  const comparable = (item) => item == null ? null : Object.fromEntries(Object.entries({ type: 'highlight', ...item })
    .filter(([key]) => !key.startsWith('_') && !['createdAt', 'updatedAt'].includes(key))
    .sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify(comparable(before)) === JSON.stringify(comparable(after));
}
export function recordChange(history, before, after) {
  if (sameAnnotation(before, after)) return history;
  // The live editor mutates annotations in place; history must own independent snapshots.
  return { undo: [...history.undo, structuredClone({ before, after })], redo: [] };
}
export function stepHistory(history, direction) {
  const source = direction === 'undo' ? history.undo : history.redo;
  if (!source.length) return { history, change: null };
  const change = source[source.length - 1];
  return { change, history: direction === 'undo'
    ? { undo: source.slice(0, -1), redo: [...history.redo, change] }
    : { undo: [...history.undo, change], redo: source.slice(0, -1) } };
}
