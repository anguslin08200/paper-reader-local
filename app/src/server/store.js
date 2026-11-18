import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtimeDirectory } from './runtime.js';

// Keep the legacy library override while isolating all data with the runtime override.
const rootDirectory = path.resolve(process.env.PAPER_READER_ROOT ?? path.join(runtimeDirectory, 'library'));
const indexPath = path.join(rootDirectory, 'index.json');

const initialIndex = {
  folders: [{ id: 'inbox', name: 'Inbox', parentId: null }],
  papers: [],
};

export async function ensureStore() {
  await mkdir(path.join(rootDirectory, 'papers'), { recursive: true });
  await mkdir(path.join(rootDirectory, 'cache', 'translations'), { recursive: true });
  try {
    await readFile(indexPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await saveIndex(initialIndex);
  }
}

export async function readIndex() {
  return JSON.parse(await readFile(indexPath, 'utf8'));
}

export async function saveIndex(index) {
  // Readers must never observe a partially written library index.
  const temporary = `${indexPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(index, null, 2));
  await rename(temporary, indexPath);
}

let mutationQueue = Promise.resolve();
export function mutateIndex(updater) {
  // Page-position autosaves and concurrent imports must not overwrite one another's records.
  const operation = mutationQueue.then(async () => {
    const index = await readIndex();
    const result = await updater(index);
    await saveIndex(index);
    return result;
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}

export function paperDirectory(paperId) {
  return path.join(rootDirectory, 'papers', paperId);
}

export function paperPdfPath(paperId) {
  return path.join(paperDirectory(paperId), 'original.pdf');
}

export function paperRagIndexPath(paperId) {
  return path.join(paperDirectory(paperId), 'rag-index.json');
}

export function translationCachePath(paperId) {
  return path.join(rootDirectory, 'cache', 'translations', `${paperId}.json`);
}

export function createPaperRecord(input) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: input.title,
    authors: input.authors ?? [],
    abstract: input.abstract ?? '',
    year: input.year ?? '',
    sourceUrl: input.sourceUrl ?? '',
    arxivId: input.arxivId ?? null,
    version: input.version ?? null,
    folderId: input.folderId || 'inbox',
    fileName: input.fileName,
    // Persist the source classification independently of the physical PDF filename.
    sourceKind: input.sourceKind ?? 'original',
    translatedVariant: input.translatedVariant ?? 'bilingual',
    importedAt: now,
    lastOpenedAt: now,
    currentPage: 1,
  };
}

export { rootDirectory };
