import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { paperDirectory, paperPdfPath } from './store.js';

// Only processes launched by this server are tracked or terminated.
const jobs = new Map();
const maxLogLength = 16000;
const timeoutMs = 6 * 60 * 60 * 1000;
const allowedEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function paths(id) {
  if (typeof id !== 'string' || !id || id === '.' || id === '..' || /[\\/:]/.test(id)) throw new Error('Invalid paper ID');
  const directory = paperDirectory(id);
  return { directory, original: paperPdfPath(id), output: path.join(directory, 'translations'), status: path.join(directory, 'pdf-translation.json') };
}

async function isPdf(file) {
  try {
    const handle = await open(file, 'r');
    try {
      const bytes = Buffer.alloc(5);
      const result = await handle.read(bytes, 0, 5, 0);
      return result.bytesRead === 5 && bytes.toString() === '%PDF-';
    } finally { await handle.close(); }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return false;
    throw error;
  }
}

async function findOutputs(id) {
  const p = paths(id);
  const found = { original: await isPdf(p.original), chinese: false, bilingual: false };
  const files = { original: found.original ? p.original : null, chinese: null, bilingual: null };
  let entries;
  try { entries = await readdir(p.output, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { found, files }; throw error; }
  // pdf2zh produces *.zh-TW.mono.pdf and *.zh-TW.dual.pdf.
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const variant = /\.zh-TW\.mono\.pdf$/i.test(entry.name) ? 'chinese' : /\.zh-TW\.dual\.pdf$/i.test(entry.name) ? 'bilingual' : null;
    if (!variant) continue;
    const file = path.join(p.output, entry.name);
    if (await isPdf(file)) { found[variant] = true; files[variant] = file; }
  }
  return { found, files };
}

// Windows readers can briefly hold the destination open during an atomic replacement.
export async function replaceStatusFile(source, target, renameFile = rename, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt++) {
    try { return await renameFile(source, target); }
    catch (error) {
      if (attempt >= 49 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      // Vary the delay to avoid repeatedly colliding with a polling reader.
      await delay(Math.min(10 + attempt * 3, 100) + Math.floor(Math.random() * 13));
    }
  }
}

async function persist(id, state) {
  // Replace a complete snapshot so polling never reads a truncated JSON file.
  const target = paths(id).status;
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
    await replaceStatusFile(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function getPdfTranslationStatus(id) {
  const p = paths(id);
  const active = jobs.get(id);
  let state = active?.state;
  if (!state) {
    try { state = JSON.parse(await readFile(p.status, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = { status: 'idle', log: '', error: null }; }
    // A previous server's process cannot be safely adopted or terminated.
    if (state.status === 'running') state = { ...state, status: 'failed', error: '伺服器已重新啟動，無法確認先前翻譯任務的狀態。' };
  }
  const outputs = (await findOutputs(id)).found;
  // Discover older translated PDFs even when no job-status file was saved with them.
  if (state.status === 'idle' && outputs.chinese && outputs.bilingual) state = { ...state, status: 'completed' };
  return { ...state, outputs };
}

export async function translatedPdfPath(id, variant) {
  if (!['original', 'chinese', 'bilingual'].includes(variant)) return null;
  return (await findOutputs(id)).files[variant];
}

export async function startPdfTranslation(id, settings = {}, options = {}) {
  const p = paths(id);
  if (jobs.has(id)) throw new Error('此論文已有翻譯任務進行中');
  const job = { state: { status: 'running', log: '', error: null, startedAt: new Date().toISOString(), finishedAt: null } };
  jobs.set(id, job); // Reserve before asynchronous checks to prevent concurrent starts.
  try {
    const config = settings.pdfTranslation ?? {};
    const provider = config.provider ?? 'Codex';
    const effort = config.effort ?? 'low';
    const parallel = Number(config.parallel ?? 8);
    const script = config.scriptPath;
    const model = config.model ?? '';
    if (typeof model !== 'string') throw new Error('Invalid PDF translation model');
    if (!['Codex', 'Claude', 'Local'].includes(provider)) throw new Error('Invalid PDF translation provider');
    if (!allowedEfforts.has(effort) || (provider === 'Claude' && !['low', 'medium', 'high'].includes(effort))) throw new Error('Invalid PDF translation effort');
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) throw new Error('PDF translation parallel must be between 1 and 8');
    if (!script || !(await stat(script)).isFile()) throw new Error('PDF 翻譯腳本不存在');
    if (!await isPdf(p.original)) throw new Error('原始 PDF 不存在或格式無效');
    await mkdir(p.output, { recursive: true });
    // Capture prior outputs so stale files cannot turn a failed new run into success.
    const before = await findOutputs(id);
    const signatures = {};
    for (const variant of ['chinese', 'bilingual']) {
      if (before.files[variant]) { const s = await stat(before.files[variant]); signatures[variant] = `${before.files[variant]}:${s.size}:${s.mtimeMs}`; }
    }
    await persist(id, job.state);
    // Keep Python caches out of the external tool and run in this paper's directory.
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-InputPdf', p.original, '-OutputDirectory', p.output, '-Provider', provider, '-Effort', effort, '-Parallel', String(parallel)];
    if (model.trim()) args.push('-Model', model.trim());
    const spawnProcess = options.spawnProcess ?? spawn;
    const child = spawnProcess('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: p.directory, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
    const append = (chunk) => { job.state.log = (job.state.log + chunk.toString()).slice(-maxLogLength); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    // Serialize snapshots so a delayed progress write cannot overwrite final status.
    let pendingWrite = Promise.resolve();
    const queueWrite = () => {
      const snapshot = { ...job.state };
      pendingWrite = pendingWrite.catch(() => {}).then(() => persist(id, snapshot));
      return pendingWrite;
    };
    const flush = setInterval(() => { queueWrite().catch(() => {}); }, 3000);
    flush.unref();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill only the process tree rooted at the child created above.
      if (options.terminateProcess) options.terminateProcess(child);
      else if (child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.on('close', (code) => { if (code !== 0) child.kill(); });
      } else child.kill();
    }, options.timeoutMs ?? timeoutMs);
    timer.unref();
    let spawnError = null;
    child.on('error', (error) => { spawnError = error; });
    child.on('close', async (code) => {
      clearTimeout(timer); clearInterval(flush);
      try {
        const after = await findOutputs(id);
        let fresh = true;
        for (const variant of ['chinese', 'bilingual']) {
          if (!after.files[variant]) { fresh = false; continue; }
          const s = await stat(after.files[variant]);
          if (`${after.files[variant]}:${s.size}:${s.mtimeMs}` === signatures[variant]) fresh = false;
        }
        if (timedOut) throw new Error('翻譯超時，已停止此任務');
        if (spawnError) throw spawnError;
        if (code !== 0) throw new Error(`翻譯程式結束，退出碼 ${code}`);
        if (!fresh) throw new Error('翻譯程式未產生新的中文及雙語 PDF');
        job.state.status = 'completed';
      } catch (error) { job.state.status = 'failed'; job.state.error = error.message; }
      job.state.finishedAt = new Date().toISOString();
      try { await queueWrite(); } catch (error) { console.error('Could not save PDF translation status:', error); } finally { jobs.delete(id); }
    });
    return getPdfTranslationStatus(id);
  } catch (error) {
    // Save setup and synchronous spawn failures for later status requests.
    job.state.status = 'failed';
    job.state.error = error.message;
    job.state.finishedAt = new Date().toISOString();
    try { await persist(id, job.state); } catch {}
    jobs.delete(id);
    throw error;
  }
}
