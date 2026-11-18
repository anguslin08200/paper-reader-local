import path from 'node:path';
import os from 'node:os';
import { mkdir, readFile, writeFile, rename, realpath, lstat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

// All exported names are generated locally; callers cannot choose a relative output path.
export const defaultExportDirectory = () => path.join(process.env.USERPROFILE || os.homedir(), 'Documents', 'Paper Reader');
export function normalizeExportDirectory(value = defaultExportDirectory()) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value) || !path.isAbsolute(value.trim())) throw new Error('匯出資料夾必須是完整路徑');
  // Device namespaces bypass ordinary Windows filesystem path rules.
  if (/^\\\\[?.]\\/.test(value.trim())) throw new Error('不支援此匯出資料夾路徑');
  return path.resolve(value.trim());
}

export function annotatedFileName(title) {
  let name = String(title || 'paper').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120).replace(/[. ]+$/g, '');
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `paper_${name}`;
  return `${name}_標註.pdf`;
}

// Restrict Explorer and file writes to one PDF directly inside the configured real directory.
export async function resolveExportPath(directory, requestedPath, { create = false, mustExist = false } = {}) {
  const root = normalizeExportDirectory(directory);
  if (create) await mkdir(root, { recursive: true });
  const physicalRoot = await realpath(root);
  if (typeof requestedPath !== 'string' || /[\x00-\x1f]/.test(requestedPath)) throw new Error('匯出檔案路徑無效');
  const candidate = path.resolve(requestedPath);
  const leaf = path.basename(candidate);
  if (/[<>:"|?*]/.test(leaf) || /[. ]$/.test(leaf) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(leaf)) throw new Error('匯出檔案名稱無效');
  // Accept the configured spelling or its realpath, but never nested paths or siblings.
  if (![root, physicalRoot].some((base) => path.relative(base, path.dirname(candidate)) === '') || !/\.pdf$/i.test(leaf)) throw new Error('檔案必須位於設定的匯出資料夾內');
  const target = path.join(physicalRoot, path.basename(candidate));
  try {
    const entry = await lstat(target);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('匯出路徑不得指向連結或資料夾');
    const physicalTarget = await realpath(target);
    if (path.relative(physicalRoot, path.dirname(physicalTarget)) !== '') throw new Error('檔案必須位於設定的匯出資料夾內');
  } catch (error) { if (error.code !== 'ENOENT' || mustExist) throw error; }
  return target;
}

async function atomicWrite(target, bytes) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, target);
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

const saves = new Map();
const paperSaves = new Map();
// Include PDF generation in the lock so an older, slower export cannot overwrite a newer save.
export async function queueAnnotatedSave(paperDirectory, operation) {
  const previous = paperSaves.get(paperDirectory) || Promise.resolve();
  const pending = previous.catch(() => {}).then(operation);
  paperSaves.set(paperDirectory, pending);
  try { return await pending; } finally { if (paperSaves.get(paperDirectory) === pending) paperSaves.delete(paperDirectory); }
}

// Serialize saves to a shared export folder, including same-title papers and backup rotation.
export async function saveAnnotatedCopy({ directory, paperDirectory, title, variant, bytes, annotations, written, warnings = [] }) {
  if (!['original', 'chinese', 'bilingual'].includes(variant)) throw new Error('PDF 版本無效');
  const root = normalizeExportDirectory(directory);
  await mkdir(root, { recursive: true });
  const key = await realpath(root);
  const previous = saves.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const output = await resolveExportPath(root, path.join(root, annotatedFileName(title)));
    const backup = output.replace(/\.pdf$/i, '.bak.pdf');
    // Reject links at both destinations before retaining the previous exported PDF.
    await resolveExportPath(root, backup);
    try {
      const oldBytes = await readFile(output);
      await atomicWrite(backup, oldBytes);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const internalPath = path.join(paperDirectory, `annotated-${variant}.pdf`);
    await atomicWrite(internalPath, bytes);
    await atomicWrite(output, bytes);
    // Save the exact annotation snapshot so reloads can distinguish newer JSON edits.
    await atomicWrite(path.join(paperDirectory, `annotated-${variant}.json`), JSON.stringify({ annotations }, null, 2));
    return { path: output, internalPath, written, warnings, savedAnnotations: annotations };
  });
  saves.set(key, operation);
  try { return await operation; } finally { if (saves.get(key) === operation) saves.delete(key); }
}

export async function readSavedAnnotations(directory) {
  const entries = await Promise.all(['original', 'chinese', 'bilingual'].map(async (variant) => {
    try {
      const data = JSON.parse(await readFile(path.join(directory, `annotated-${variant}.json`), 'utf8'));
      return [variant, Array.isArray(data.annotations) ? data.annotations : []];
    } catch (error) { if (error.code !== 'ENOENT') throw error; return [variant, []]; }
  }));
  return Object.fromEntries(entries);
}

export async function openExportFolder(directory, requestedPath) {
  const target = await resolveExportPath(directory, requestedPath, { mustExist: true });
  // Argument array and shell:false keep titles and paths out of command interpretation.
  await new Promise((resolve, reject) => {
    const child = spawn('explorer.exe', [`/select,${target}`], { windowsHide: true, shell: false, stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return target;
}
