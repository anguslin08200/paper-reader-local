import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { paperDirectory, paperPdfPath, paperRagIndexPath } from './store.js';
import { buildPaperRagIndex } from './rag.js';

const jobs = new Map();
const failedStarts = new Map();
const statusPath = (id) => path.join(paperDirectory(id), 'parse-status.json');

async function persistStatus(id, state) {
  // Pollers must see either the previous snapshot or the complete next one.
  const target = statusPath(id);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state));
  await rename(temporary, target);
}

export async function getParseStatus(id) {
  if (jobs.has(id)) return jobs.get(id).state;
  if (failedStarts.has(id)) return failedStarts.get(id);
  try {
    const state = JSON.parse(await readFile(statusPath(id), 'utf8'));
    // A process restart cannot leave a paper permanently "parsing".
    return state.status === 'running' ? { ...state, status: 'failed', error: '服務已重啟，請重新解析' } : state;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      await readFile(paperRagIndexPath(id));
      return { status: 'completed' };
    } catch (missing) {
      if (missing.code !== 'ENOENT') throw missing;
      return { status: 'idle' };
    }
  }
}

export async function startParseJob(id) {
  if (jobs.has(id)) return jobs.get(id).state;
  const state = { status: 'running', startedAt: new Date().toISOString(), error: null };
  const job = { state };
  jobs.set(id, job);
  failedStarts.delete(id);
  try { await persistStatus(id, state); }
  catch (error) {
    // A status-file failure cannot undo an already imported, readable PDF.
    Object.assign(state, { status: 'failed', error: `無法啟動解析：${error.message}` });
    failedStarts.set(id, state);
    jobs.delete(id);
    return state;
  }
  // Import returns immediately after the PDF is durable; only this background job can fail.
  job.promise = (async () => {
    const directory = paperDirectory(id);
    const staging = path.join(directory, `.parse-${randomUUID()}`);
    try {
      // Stage extraction and indexing together, preserving the original and the last working index.
      await mkdir(staging);
      const index = await buildPaperRagIndex(await readFile(paperPdfPath(id)), staging, { signal: AbortSignal.timeout(15 * 60_000) });
      const temporaryIndex = path.join(staging, 'rag-index.json');
      await writeFile(temporaryIndex, JSON.stringify(index));
      const parsed = path.join(directory, 'parsed');
      const backup = path.join(directory, `.parsed-backup-${randomUUID()}`);
      let backedUp = false;
      let replaced = false;
      try {
        try { await rename(parsed, backup); backedUp = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await rename(path.join(staging, 'parsed'), parsed);
        replaced = true;
        await rename(temporaryIndex, paperRagIndexPath(id));
      } catch (error) {
        if (replaced) await rm(parsed, { recursive: true, force: true });
        if (backedUp) await rename(backup, parsed);
        throw error;
      }
      if (backedUp) await rm(backup, { recursive: true, force: true });
      // Metadata is diagnostic; failure to copy it must not invalidate committed parsed content.
      await readFile(path.join(staging, 'parse-task.json')).then((data) => writeFile(path.join(directory, 'parse-task.json'), data)).catch(() => {});
      Object.assign(state, { status: 'completed', sha256: index.sha256, parser: index.parser, sectionCount: index.sections.length });
    } catch (error) {
      Object.assign(state, { status: 'failed', error: error.message });
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      state.finishedAt = new Date().toISOString();
      await persistStatus(id, state).catch(() => {});
      jobs.delete(id);
    }
  })();
  return state;
}

export function isParsing(id) { return jobs.has(id); }
