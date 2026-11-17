import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { mineruConfig } from './mineru-config.js';

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function joinUrl(baseUrl, pathname) {
  return `${String(baseUrl).replace(/\/+$/, '')}/${pathname.replace(/^\/+/, '')}`;
}

function expertError(message) {
  return new Error(`智譜 Expert：${message}`);
}

function responseStatus(response) {
  return Number(response?.status ?? 0);
}

async function responsePayload(response) {
  if (typeof response?.text === 'function') {
    const raw = await response.text();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }
  if (typeof response?.json === 'function') return response.json();
  return {};
}

function responseDetail(payload) {
  if (typeof payload === 'string') return payload;
  return payload?.error?.message
    || payload?.error
    || payload?.message
    || payload?.raw
    || '';
}

async function expertRequest(url, init, operation) {
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const cause = error?.cause?.code || error?.message || String(error);
    throw expertError(`${operation}網路請求失敗：${cause}`);
  }
  let payload;
  try {
    payload = await responsePayload(response);
  } catch (error) {
    throw expertError(`${operation}響應讀取失敗：${error.message}`);
  }
  if (!response.ok) {
    const detail = responseDetail(payload);
    throw expertError(`${operation}請求失敗：HTTP ${responseStatus(response)}${detail ? `，${detail}` : ''}`);
  }
  return payload;
}

function nestedValue(payload, keys) {
  for (const value of [payload, payload?.data, payload?.result]) {
    if (!value || typeof value !== 'object') continue;
    for (const key of keys) {
      if (value[key] !== undefined && value[key] !== null) return value[key];
    }
  }
  return undefined;
}

function taskIdFrom(payload) {
  const taskId = nestedValue(payload, ['task_id', 'taskId', 'id']);
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw expertError('檔案解析建立響應缺少 task_id');
  }
  return taskId;
}

function statusFrom(payload) {
  const status = nestedValue(payload, ['status', 'state']);
  return typeof status === 'string' ? status.toLowerCase() : '';
}

function downloadLinkFrom(payload) {
  const link = nestedValue(payload, ['parsing_result_url', 'parsingResultUrl', 'download_link', 'downloadLink', 'download_url', 'downloadUrl']);
  if (typeof link !== 'string' || !link) throw expertError('解析成功響應缺少下載連結');
  return link;
}

function withoutSignedLinks(value) {
  if (Array.isArray(value)) return value.map(withoutSignedLinks);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^(download[_-]?(link|url)|parsing[_-]?result[_-]?url|signed[_-]?url)$/i.test(key)) continue;
    result[key] = withoutSignedLinks(child);
  }
  return result;
}

async function saveTaskMetadata(filePath, metadata) {
  await writeFile(filePath, JSON.stringify(withoutSignedLinks(metadata), null, 2));
}

function sleep(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(expertError('請求已取消'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function validateZipEntryName(entryName) {
  if (typeof entryName !== 'string' || !entryName || entryName.includes('\\') || entryName.includes('\0')) {
    throw expertError(`ZIP 包包含不安全路徑：${String(entryName)}`);
  }
  if (entryName.startsWith('/') || /^[A-Za-z]:/.test(entryName)) {
    throw expertError(`ZIP 包包含不安全路徑：${entryName}`);
  }
  const normalized = path.posix.normalize(entryName);
  if (normalized !== entryName || normalized === '..' || normalized.startsWith('../')) {
    throw expertError(`ZIP 包包含不安全路徑：${entryName}`);
  }
  return normalized;
}

function outputPathForEntry(parsedDirectory, entryName) {
  const outputPath = path.resolve(parsedDirectory, ...entryName.split('/'));
  const relative = path.relative(parsedDirectory, outputPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw expertError(`ZIP 包包含不安全路徑：${entryName}`);
  }
  return outputPath;
}

async function extractResultZip(zipBuffer, directory) {
  let entries;
  try {
    entries = unzipSync(new Uint8Array(zipBuffer));
  } catch (error) {
    throw expertError(`ZIP 結果解析失敗：${error.message}`);
  }

  const parsedDirectory = path.join(directory, 'parsed');
  const result = entries['result.md'];
  const resultBytes = result && !(result instanceof Uint8Array) ? new Uint8Array(result) : result;
  if (!resultBytes || !strFromU8(resultBytes).trim()) {
    throw expertError('ZIP 結果缺少非空 result.md');
  }

  const imageEntries = [];
  for (const [entryName, bytes] of Object.entries(entries)) {
    const safeName = validateZipEntryName(entryName);
    if (safeName === 'result.md') continue;
    if (safeName.startsWith('images/') && safeName !== 'images/' && !safeName.endsWith('/')) {
      imageEntries.push([safeName, bytes]);
    }
  }

  await mkdir(path.join(parsedDirectory, 'images'), { recursive: true });
  await writeFile(path.join(parsedDirectory, 'result.md'), strFromU8(resultBytes));
  await writeFile(path.join(parsedDirectory, 'result.zip'), Buffer.from(zipBuffer));
  const images = [];
  for (const [entryName, bytes] of imageEntries) {
    const outputPath = outputPathForEntry(parsedDirectory, entryName);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(bytes));
    images.push({ path: path.posix.join('parsed', entryName) });
  }
  return { markdown: strFromU8(resultBytes), images };
}

/**
 * Parse a PDF using Zhipu's Expert file parser and persist its result.
 * @param {Buffer|Uint8Array} pdfBuffer
 * @param {string} directory
 * @param {object} settings
 * @param {AbortSignal} signal
 * @param {{pollIntervalMs?: number, timeoutMs?: number}} options
 */
export async function parsePdfWithExpert(
  pdfBuffer,
  directory,
  settings = {},
  signal,
  options = {},
) {
  const apiKey = settings?.rag?.parserApiKey ?? process.env.GLM_API_KEY ?? '';
  if (!apiKey) throw expertError('未配置 parser API key（GLM_API_KEY）');
  const baseUrl = settings?.rag?.parserBaseUrl || DEFAULT_BASE_URL;
  const pollIntervalMs = Math.max(0, Number(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));

  await mkdir(directory, { recursive: true });
  const form = new FormData();
  form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), 'original.pdf');
  form.append('tool_type', 'expert');
  form.append('file_type', 'PDF');

  const createResponse = await expertRequest(
    joinUrl(baseUrl, '/files/parser/create'),
    { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal },
    '檔案上傳',
  );
  const taskId = taskIdFrom(createResponse);
  const taskPath = path.join(directory, 'parse-task.json');
  await saveTaskMetadata(taskPath, { task_id: taskId, create: createResponse, status: 'uploaded' });

  const deadline = Date.now() + timeoutMs;
  let pollResponse;
  while (true) {
    if (Date.now() > deadline) throw expertError(`解析任務超時（${timeoutMs}ms）`);
    pollResponse = await expertRequest(
      joinUrl(baseUrl, `/files/parser/result/${encodeURIComponent(taskId)}/download_link`),
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` }, signal },
      '解析任務查詢',
    );
    const status = statusFrom(pollResponse);
    await saveTaskMetadata(taskPath, { task_id: taskId, create: createResponse, result: pollResponse, status });
    if (status === 'succeeded') break;
    if (status !== 'processing') {
      throw expertError(`解析任務失敗：狀態 ${status || '未知'}`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw expertError(`解析任務超時（${timeoutMs}ms）`);
    await sleep(Math.min(pollIntervalMs, remaining), signal);
  }

  const downloadLink = downloadLinkFrom(pollResponse);
  let downloadResponse;
  try {
    downloadResponse = await fetch(downloadLink, { method: 'GET', signal });
  } catch (error) {
    const cause = error?.cause?.code || error?.message || String(error);
    throw expertError(`結果下載網路請求失敗：${cause}`);
  }
  if (!downloadResponse.ok) {
    throw expertError(`結果下載請求失敗：HTTP ${responseStatus(downloadResponse)}`);
  }
  let zipBuffer;
  try {
    zipBuffer = await downloadResponse.arrayBuffer();
  } catch (error) {
    throw expertError(`結果下載讀取失敗：${error.message}`);
  }
  const parsed = await extractResultZip(zipBuffer, directory);
  return { ...parsed, taskId };
}


// MinerU runs locally; its cache is read-only and keyed by the PDF's content.
const runFile = promisify(execFile);

async function cachedMineruEntries(cacheDirectory, sha256) {
  try {
    const root = path.join(cacheDirectory, sha256);
    const manifest = JSON.parse(await readFile(path.join(root, 'cache.json'), 'utf8'));
    if (manifest.sha !== sha256 || !Array.isArray(manifest.files)) return null;
    const markdown = await readFile(path.join(root, 'markdown.md'));
    if (!markdown.toString('utf8').trim()) return null;
    const entries = { 'markdown.md': markdown };
    for (const name of manifest.files) {
      if (typeof name !== 'string' || !name || path.basename(name) !== name || name.includes('\\') || name === '.' || name === '..') return null;
      entries[`images/${name}`] = await readFile(path.join(root, 'images', name));
    }
    try { entries['middle_json.json'] = await readFile(path.join(root, 'middle_json.json')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return entries;
  } catch {
    return null;
  }
}

async function persistMineruEntries(entries, directory, sha256) {
  // Validate every archive path before writing any extracted file.
  for (const name of Object.keys(entries)) validateZipEntryName(name);
  const names = Object.keys(entries);
  const markdownName = names.find((name) => name === 'markdown.md')
    ?? names.find((name) => name.endsWith('/markdown.md'));
  if (!markdownName || !Buffer.from(entries[markdownName]).toString('utf8').trim()) {
    throw new Error('MinerU ZIP is missing a non-empty markdown.md');
  }
  const prefix = markdownName.slice(0, -'markdown.md'.length);
  const parsedDirectory = path.join(directory, 'parsed');
  await rm(path.join(parsedDirectory, 'images'), { recursive: true, force: true });
  await mkdir(path.join(parsedDirectory, 'images'), { recursive: true });
  const markdown = Buffer.from(entries[markdownName]).toString('utf8');
  await writeFile(path.join(parsedDirectory, 'result.md'), markdown);
  const images = [];
  for (const [name, bytes] of Object.entries(entries)) {
    if (!name.startsWith(`${prefix}images/`) || name.endsWith('/')) continue;
    const relative = name.slice(prefix.length);
    const output = outputPathForEntry(parsedDirectory, relative);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, bytes);
    images.push({ path: path.posix.join('parsed', relative) });
  }
  const middle = entries[`${prefix}middle_json.json`];
  if (middle) await writeFile(path.join(parsedDirectory, 'middle_json.json'), middle);
  else await rm(path.join(parsedDirectory, 'middle_json.json'), { force: true });
  await writeFile(path.join(directory, 'parse-task.json'), JSON.stringify({ provider: 'mineru', sha256 }, null, 2));
  return { markdown, images, sha256 };
}

export async function parsePdfWithMineru(pdfBuffer, directory, settings = {}, signal, options = {}) {
  const config = mineruConfig(settings.rag);
  const sha256 = createHash('sha256').update(pdfBuffer).digest('hex');
  await mkdir(directory, { recursive: true });
  const pdfPath = path.resolve(directory, 'original.pdf');
  // Never truncate an existing original while the reader or another tool may be using it.
  try { await writeFile(pdfPath, pdfBuffer, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (createHash('sha256').update(await readFile(pdfPath)).digest('hex') !== sha256) {
      throw new Error('MinerU 目錄已有不同的原始 PDF，拒絕覆蓋');
    }
  }
  // An empty cache path disables cache lookup instead of reading from the current directory.
  const cached = config.cacheDirectory ? await cachedMineruEntries(config.cacheDirectory, sha256) : null;
  if (cached) {
    await rm(path.join(directory, 'parsed', 'result.zip'), { force: true });
    return persistMineruEntries(cached, directory, sha256);
  }
  const parsedDirectory = path.join(directory, 'parsed');
  await mkdir(parsedDirectory, { recursive: true });
  await rm(path.join(parsedDirectory, 'result.zip'), { force: true });
  // MinerU writes deep temporary folders next to its output; deep library paths can exceed the
  // Windows 260-character limit, so run it in a short system temp folder and copy the ZIP back.
  const workDirectory = await mkdtemp(path.join(tmpdir(), 'pr-mineru-'));
  const zipPath = path.join(workDirectory, 'result.zip');
  let archive;
  try {
    await (options.runFile ?? runFile)(config.executable,
      ['parse', pdfPath, '-o', zipPath, '-f', 'zip', '--tier', 'standard'],
      { env: { ...process.env, MINERU_HOME: config.home, PYTHONIOENCODING: 'utf-8' }, signal, timeout: DEFAULT_TIMEOUT_MS, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    archive = await readFile(zipPath);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
  let entries;
  try { entries = unzipSync(archive); } catch (error) { throw new Error(`Invalid MinerU ZIP: ${error.message}`); }
  return persistMineruEntries(entries, directory, sha256);
}

export async function parsePdf(pdfBuffer, directory, settings = {}, signal, options = {}) {
  if (settings.rag?.parserProvider === 'zhipu') return parsePdfWithExpert(pdfBuffer, directory, settings, signal, options);
  return parsePdfWithMineru(pdfBuffer, directory, settings, signal, options);
}
