import { resolveAttachments } from './attachments.js';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanPaperTitle, findLocalArxivId, normalizeText } from '../shared/paper.js';
import {
  ensureStore,
  readIndex,
  mutateIndex,
  paperDirectory,
  paperPdfPath,
  translationCachePath,
  createPaperRecord,
} from './store.js';
import { getArxivPaper } from './arxiv.js';
import { translateText } from './model.js';
import { getAppSettings, publicSettings, saveAppSettings, writePromptTemplates } from './settings.js';
import { runPaperAgent, listCodexModels, getPiStatus } from './pi.js';
import { getParseStatus, startParseJob, isParsing } from './parse-jobs.js';
import { startPdfTranslation, getPdfTranslationStatus, translatedPdfPath } from './pdf-translation.js';
import { detectPdfSource, sourceSelection } from './source-detection.js';
import { createPdfImporter } from './import-service.js';
import { listPaperElements, elementImagePath, loadPaperLayout, paperCounterpart, paperBlocks } from './elements.js';
import { readChat, updateChat, resetChat, appendTurn, historyContext } from './chat-store.js';
import { readAnnotations, mutateAnnotations, sanitizeAnnotation, exportAnnotatedPdf } from './annotations.js';
import { annotatedFileName, saveAnnotatedCopy, readSavedAnnotations, openExportFolder, queueAnnotatedSave } from './annotation-save.js';
import { abortOnResponseClose } from './response-abort.js';

// Preview tokens retain downloaded arXiv bytes briefly to avoid a second download.
const previews = new Map();

const projectRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const staticRoot = path.join(projectRoot, 'dist');
const port = Number(process.env.PORT || 3080);
const bodyLimit = 80 * 1024 * 1024;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mjs': 'text/javascript; charset=utf-8',
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendError(res, error) {
  const status = error.statusCode || 400;
  sendJson(res, status, { error: error.message });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > bodyLimit) {
      const error = new Error('請求內容超過大小限制');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function paperResponse(paper) {
  return {
    ...paper,
    pdfUrl: `/api/papers/${paper.id}/pdf`,
  };
}

async function updatePaper(paperId, updater) {
  return mutateIndex((index) => {
    const paper = index.papers.find((item) => item.id === paperId);
    if (!paper) throw notFound('論文不存在');
    updater(paper, index);
    return paper;
  });
}

function notFound(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

// Inject the existing jobs and storage operations so import orchestration can be tested without a provider.
const importPdf = createPdfImporter({ detectPdfSource, sourceSelection, createPaperRecord, paperDirectory,
  paperPdfPath, mkdir, writeFile, mutateIndex, rm, startParseJob, startPdfTranslation, getAppSettings });

async function importLocalPdf(body) {
  const match = String(body.data ?? '').match(/^data:application\/pdf;base64,(.+)$/s);
  if (!match) throw new Error('上傳內容必須是 PDF data URL');
  const fileName = String(body.fileName || 'paper.pdf').replace(/[/\\]/g, '-');
  const firstPageText = normalizeText(body.firstPageText);
  let metadata = { title: cleanPaperTitle(fileName.replace(/\.pdf$/i, '')) || '未命名論文' };
  let metadataError = null;
  try {
    // Local imports never wait for a remote metadata service or spend an assistant turn.
    const local = findLocalArxivId(fileName, firstPageText);
    if (local) metadata = { ...metadata, arxivId: local.arxivId, version: local.version };
  } catch (error) {
    metadataError = error.message;
  }
  const paper = await importPdf({
    pdfBuffer: Buffer.from(match[1], 'base64'),
    metadata: { ...metadata, title: cleanPaperTitle(metadata.title), fileName, folderId: body.folderId },
    body,
  });
  return { paper, metadataError };
}

async function downloadArxiv(url) {
  const metadata = await getArxivPaper(url);
  const response = await fetch(metadata.pdfUrl);
  if (!response.ok) throw new Error(`arXiv PDF download failed: HTTP ${response.status}`);
  return { metadata, pdfBuffer: Buffer.from(await response.arrayBuffer()), fileName: `${metadata.arxivId}.pdf` };
}

async function importArxivPdf(body) {
  const cached = previews.get(body.previewToken);
  if (body.previewToken && (!cached || cached.expires < Date.now())) throw new Error('Preview expired; preview the paper again');
  const item = cached || await downloadArxiv(body.url);
  if (body.previewToken) previews.delete(body.previewToken);
  return importPdf({ pdfBuffer: item.pdfBuffer, metadata: { ...item.metadata, fileName: item.fileName, folderId: body.folderId }, body });
}

async function previewPdf(body) {
  let item;
  if (body.url) item = await downloadArxiv(body.url);
  else {
    const match = String(body.data ?? '').match(/^data:application\/pdf;base64,(.+)$/s);
    if (!match) throw new Error('Invalid PDF data URL');
    item = { pdfBuffer: Buffer.from(match[1], 'base64'), fileName: String(body.fileName || 'paper.pdf') };
  }
  if (!item.pdfBuffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('Invalid PDF');
  const detected = await detectPdfSource(item.fileName, item.pdfBuffer);
  if (!body.url) return detected;
  // Keep at most ten short-lived preview downloads in memory.
  for (const [key, value] of previews) if (value.expires < Date.now()) previews.delete(key);
  while (previews.size >= 10) previews.delete(previews.keys().next().value);
  const previewToken = randomUUID();
  previews.set(previewToken, { ...item, expires: Date.now() + 15 * 60 * 1000 });
  return { ...detected, metadata: item.metadata, fileName: item.fileName, previewToken };
}

async function reindexPaper(paperId) {
  let pdfBuffer;
  try {
    pdfBuffer = await readFile(paperPdfPath(paperId));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('未找到論文 PDF 檔案，無法重建索引');
    throw error;
  }
  return startParseJob(paperId);
}

async function readTranslations(paperId) {
  try {
    return JSON.parse(await readFile(translationCachePath(paperId), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function cachedTranslation(paperId, input) {
  const translations = await readTranslations(paperId);
  const hit = translations.find((item) => (
    item.sourceText === input.text
    && item.sourceLanguage === input.sourceLanguage
    && item.targetLanguage === input.targetLanguage
  ));
  if (hit) return { ...hit, cached: true };
  const result = await translateText(input);
  const next = {
    sourceText: input.text,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    result,
    translatedAt: new Date().toISOString(),
  };
  translations.push(next);
  await writeFile(translationCachePath(paperId), JSON.stringify(translations, null, 2));
  return { ...next, cached: false };
}

async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  // 「整個城市 shut down」: stop this local server after replying (the window closes itself).
  if (req.method === 'POST' && url.pathname === '/api/shutdown') {
    // A JSON content type forces a CORS preflight, so other websites cannot trigger this.
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('Invalid request');
    sendJson(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 300);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/settings') {
    sendJson(res, 200, publicSettings(await getAppSettings()));
    return;
  }
  // Model enumeration and Pi status are read-only and never start a model turn.
  if (req.method === 'GET' && url.pathname === '/api/agent/models') {
    sendJson(res, 200, await listCodexModels());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/agent/status') {
    sendJson(res, 200, { pi: await getPiStatus() });
    return;
  }
  if (req.method === 'PUT' && url.pathname === '/api/settings') {
    const settings = await saveAppSettings(await readJsonBody(req));
    await writePromptTemplates(settings);
    sendJson(res, 200, publicSettings(settings));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/library') {
    const index = await readIndex();
    const papers = await Promise.all(index.papers.map(async (paper) => ({ ...paperResponse(paper), parseStatus: await getParseStatus(paper.id) })));
    sendJson(res, 200, { folders: index.folders, papers });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/folders') {
    const body = await readJsonBody(req);
    const name = normalizeText(body.name);
    if (!name) throw new Error('資料夾名稱不能為空');
    const parentId = body.parentId || null;
    const folder = { id: cryptoRandomId(), name, parentId };
    await mutateIndex((index) => {
      if (parentId && !index.folders.some((item) => item.id === parentId)) throw notFound('父資料夾不存在');
      index.folders.push(folder);
    });
    sendJson(res, 201, folder);
    return;
  }
  if (req.method === 'PATCH' && segments[1] === 'folders' && segments[2]) {
    const body = await readJsonBody(req);
    const name = normalizeText(body.name);
    if (!name) throw new Error('資料夾名稱不能為空');
    const folder = await mutateIndex((index) => {
      const target = index.folders.find((item) => item.id === segments[2]);
      if (!target) throw notFound('資料夾不存在');
      target.name = name;
      return target;
    });
    sendJson(res, 200, folder);
    return;
  }
  if (req.method === 'DELETE' && segments[1] === 'folders' && segments[2]) {
    const folderId = segments[2];
    if (folderId === 'inbox') throw new Error('Inbox 資料夾用於儲存預設匯入論文，不能刪除');
    const { folderIds, paperIds } = await mutateIndex(async (index) => {
      if (!index.folders.some((folder) => folder.id === folderId)) throw notFound('資料夾不存在');
      const folderIds = collectFolderTree(index.folders, folderId);
      const paperIds = index.papers.filter((paper) => folderIds.has(paper.folderId)).map((paper) => paper.id);
      // Do not remove a directory while a tool is writing into it.
      for (const id of paperIds) await assertNoBackgroundJob(id);
      for (const id of paperIds) {
        await rm(paperDirectory(id), { recursive: true, force: true });
        await rm(translationCachePath(id), { force: true });
      }
      index.folders = index.folders.filter((folder) => !folderIds.has(folder.id));
      index.papers = index.papers.filter((paper) => !paperIds.includes(paper.id));
      return { folderIds, paperIds };
    });
    sendJson(res, 200, { deletedFolderIds: [...folderIds], deletedPaperIds: paperIds });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/papers/preview') {
    sendJson(res, 200, await previewPdf(await readJsonBody(req)));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/papers/upload') {
    const { paper, metadataError } = await importLocalPdf(await readJsonBody(req));
    sendJson(res, 201, { ...paperResponse(paper), metadataError });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/papers/arxiv') {
    const paper = await importArxivPdf(await readJsonBody(req));
    sendJson(res, 201, paperResponse(paper));
    return;
  }

  const paperId = segments[2];
  const action = segments[3];
  if (segments[1] !== 'papers' || !paperId) throw notFound('介面不存在');
  const index = await readIndex();
  const paper = index.papers.find((item) => item.id === paperId);
  if (!paper) throw notFound('論文不存在');

  if (req.method === 'GET' && action === 'pdf') {
    const variant = url.searchParams.get('variant') || 'original';
    // A translated upload stays on disk as original.pdf but is served under its variant.
    const pdfPath = variant === 'original' || (paper.sourceKind === 'translated' && variant === paper.translatedVariant) ? paperPdfPath(paperId) : await translatedPdfPath(paperId, variant);
    if (!pdfPath) throw notFound('該版本 PDF 尚未生成');
    await readFile(pdfPath); // Surface missing files through the normal JSON error path.
    res.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'no-cache' });
    createReadStream(pdfPath).on('error', () => res.destroy()).pipe(res);
    return;
  }
  if (req.method === 'GET' && action === 'status') {
    const [parse, translation] = await Promise.all([getParseStatus(paperId), getPdfTranslationStatus(paperId)]);
    if (paper.sourceKind === 'translated') {
      translation.outputs.original = false;
      translation.outputs[paper.translatedVariant || 'bilingual'] = true;
    }
    sendJson(res, 200, { parse, translation });
    return;
  }
  // MinerU element list (figures, tables, algorithms, equations) for the assistant's figure panel.
  if (req.method === 'GET' && action === 'elements') {
    // Hotspots cover both halves of bilingual pages; translated copies point at their English twin.
    sendJson(res, 200, await loadPaperLayout(paperDirectory(paperId)));
    return;
  }
  // Matching paragraph(s) from the other half of a side-by-side bilingual page.
  if (req.method === 'POST' && action === 'counterpart') {
    const body = await readJsonBody(req);
    const rect = body.rect || {};
    const valid = ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(Number(rect[key])));
    if (!valid) throw new Error('選取範圍無效');
    const normalized = { x: Number(rect.x), y: Number(rect.y), w: Number(rect.w), h: Number(rect.h) };
    const pageNumber = Math.max(1, Number(body.page) || 1);
    // Generated side-by-side translations: the client sends original-page coordinates and
    // receives the matching original paragraphs (with boxes to locate the translated half).
    if (body.generatedDual === true) {
      sendJson(res, 200, { blocks: await paperBlocks(paperDirectory(paperId), pageNumber, normalized) });
      return;
    }
    sendJson(res, 200, { counterpart: await paperCounterpart(paperDirectory(paperId), pageNumber, normalized) });
    return;
  }
  if (req.method === 'GET' && action === 'element-image') {
    // Only names matching parsed/images/<file> are served; anything else is rejected before disk access.
    const imagePath = elementImagePath(paperDirectory(paperId), url.searchParams.get('path'));
    if (!imagePath) throw notFound('圖片不存在');
    const data = await readFile(imagePath);
    res.writeHead(200, { 'content-type': mimeTypes[path.extname(imagePath).toLowerCase()] || 'image/jpeg', 'cache-control': 'max-age=3600' });
    res.end(data);
    return;
  }
  // Highlights and notes (Adobe-style), stored per paper and exportable into the PDF.
  if (action === 'annotations') {
    const directory = paperDirectory(paperId);
    const annotationId = segments[4];
    if (req.method === 'GET' && !annotationId) {
      // The saved snapshot keeps the PDF dirty indicator accurate after a reload.
      sendJson(res, 200, { annotations: await readAnnotations(directory), savedAnnotations: await readSavedAnnotations(directory) });
      return;
    }
    if (req.method === 'POST' && !annotationId) {
      const body = await readJsonBody(req);
      const clean = sanitizeAnnotation(body);
      // Undo can recreate an annotation with its original UUID; reject arbitrary path-like IDs.
      if (body.id !== undefined && (typeof body.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.id))) throw new Error('標註識別碼無效');
      const now = new Date().toISOString();
      const created = await mutateAnnotations(directory, (list) => {
        const id = body.id || randomUUID();
        if (list.some((item) => item.id === id)) throw new Error('標註識別碼已存在');
        const annotation = { id, ...clean, createdAt: now, updatedAt: now };
        list.push(annotation);
        return annotation;
      });
      sendJson(res, 201, created);
      return;
    }
    if ((req.method === 'PATCH' || req.method === 'DELETE') && annotationId) {
      const body = req.method === 'PATCH' ? await readJsonBody(req) : null;
      const result = await mutateAnnotations(directory, (list) => {
        const index = list.findIndex((item) => item.id === annotationId);
        if (index < 0) throw notFound('標註不存在');
        if (req.method === 'DELETE') { list.splice(index, 1); return { deleted: annotationId }; }
        list[index] = { ...list[index], ...sanitizeAnnotation(body, list[index]), updatedAt: new Date().toISOString() };
        return list[index];
      });
      sendJson(res, 200, result);
      return;
    }
  }
  if (req.method === 'POST' && action === 'open-export-folder') {
    const { path: requestedPath } = await readJsonBody(req);
    const settings = await getAppSettings();
    const selected = await openExportFolder(settings.exportDirectory, requestedPath);
    sendJson(res, 200, { path: selected });
    return;
  }
  if (req.method === 'POST' && action === 'save-annotated') {
    const { variant = 'original' } = await readJsonBody(req);
    if (!['original', 'chinese', 'bilingual'].includes(variant)) throw new Error('PDF 版本無效');
    // Always export from the base file; saved copies are never fed back into the overlay reader.
    const pdfPath = variant === 'original' || (paper.sourceKind === 'translated' && variant === paper.translatedVariant) ? paperPdfPath(paperId) : await translatedPdfPath(paperId, variant);
    if (!pdfPath) throw notFound('該版本 PDF 尚未生成');
    const saved = await queueAnnotatedSave(paperDirectory(paperId), async () => {
      const annotations = (await readAnnotations(paperDirectory(paperId))).filter((item) => item.variant === variant);
      const result = await exportAnnotatedPdf(await readFile(pdfPath), annotations, { title: paper.title });
      const settings = await getAppSettings();
      return saveAnnotatedCopy({ directory: settings.exportDirectory, paperDirectory: paperDirectory(paperId), title: paper.title, variant, annotations, ...result });
    });
    sendJson(res, 200, saved);
    return;
  }
  if (req.method === 'GET' && action === 'export-annotated') {
    const variant = url.searchParams.get('variant') || 'original';
    if (!['original', 'chinese', 'bilingual'].includes(variant)) throw new Error('PDF 版本無效');
    // Same file resolution as the PDF route; only highlights drawn on this variant are written.
    const pdfPath = variant === 'original' || (paper.sourceKind === 'translated' && variant === paper.translatedVariant) ? paperPdfPath(paperId) : await translatedPdfPath(paperId, variant);
    if (!pdfPath) throw notFound('該版本 PDF 尚未生成');
    const annotations = (await readAnnotations(paperDirectory(paperId))).filter((item) => item.variant === variant);
    const { bytes } = await exportAnnotatedPdf(await readFile(pdfPath), annotations, { title: paper.title });
    const name = annotatedFileName(paper.title);
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="annotated.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'no-cache',
    });
    res.end(Buffer.from(bytes));
    return;
  }
  // Persisted conversation for this paper (restored after reloads and server restarts).
  if (req.method === 'GET' && action === 'chat') {
    const chat = await readChat(paperDirectory(paperId));
    sendJson(res, 200, { turns: chat.turns, memory: chat.claude ? 'claude-session' : 'transcript' });
    return;
  }
  if (req.method === 'DELETE' && action === 'chat') {
    await resetChat(paperDirectory(paperId));
    sendJson(res, 200, { turns: [] });
    return;
  }
  if (req.method === 'PATCH' && action === 'source') {
    const body = await readJsonBody(req);
    const selection = sourceSelection(body, paper);
    const updated = await updatePaper(paperId, (target) => Object.assign(target, selection));
    sendJson(res, 200, paperResponse(updated));
    return;
  }
  if (req.method === 'POST' && action === 'translate-pdf') {
    if (paper.sourceKind === 'translated') throw new Error('此為已翻譯版，無需再翻譯');
    sendJson(res, 202, await startPdfTranslation(paperId, await getAppSettings()));
    return;
  }
  if (req.method === 'POST' && action === 'position') {
    const body = await readJsonBody(req);
    const updated = await updatePaper(paperId, (target) => {
      target.currentPage = Math.max(1, Number(body.page) || 1);
      target.lastOpenedAt = new Date().toISOString();
    });
    sendJson(res, 200, paperResponse(updated));
    return;
  }
  if (req.method === 'POST' && action === 'reindex') {
    sendJson(res, 202, await reindexPaper(paperId));
    return;
  }
  if (req.method === 'POST' && action === 'translate') {
    const body = await readJsonBody(req);
    const text = normalizeText(body.text);
    if (!text) throw new Error('翻譯內容不能為空');
    const result = await cachedTranslation(paperId, {
      text,
      sourceLanguage: body.sourceLanguage || 'auto',
      targetLanguage: '繁體中文（台灣）',
      provider: body.provider,
    });
    sendJson(res, 200, result);
    return;
  }
  if (req.method === 'POST' && action === 'ask') {
    const body = await readJsonBody(req);
    const question = normalizeText(body.question);
    if (!question) throw new Error('問題不能為空');
    // Resolve selected IDs against server-owned MinerU data; never trust client element text.
    const attachments = await resolveAttachments(body, await listPaperElements(paperDirectory(paperId)), async (element) => {
      const imagePath = elementImagePath(paperDirectory(paperId), element.image);
      if (!imagePath) return null;
      const extension = imagePath.toLowerCase().endsWith('.png') ? 'png' : imagePath.toLowerCase().endsWith('.webp') ? 'webp' : 'jpeg';
      return `data:image/${extension};base64,${(await readFile(imagePath)).toString('base64')}`;
    });
    const context = {
      paper, page: body.page, attachments,
      currentPageText: normalizeText(body.pageText), previousAnswer: normalizeText(body.previousAnswer),
    };
    const images = attachments.map((item) => item.image).filter(Boolean);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // Close the owned assistant process when the browser disconnects.
    const requestAbort = abortOnResponseClose(res);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    try {
      let answer = '';
      let claudeSession = null;
      // Saved per-paper conversation: replayed for Codex/Pi, resumed natively for Claude.
      const chat = await readChat(paperDirectory(paperId));
      context.history = historyContext(chat.turns);
      await runPaperAgent({
        question,
        context,
        images,
        task: body.task || 'question',
        // Unknown option values are ignored by the shared prompt selector.
        detail: body.detail, exampleLevel: body.exampleLevel,
        chat,
        onClaudeSession: (session) => { claudeSession = session; },
        onDelta: (delta) => { answer += delta; emit('token', { text: delta }); },
        signal: requestAbort.signal,
        onStatus: (message) => emit('status', { message }),
      });
      // Do not persist a completed answer after its client disconnected.
      if (requestAbort.signal.aborted) return;
      if (!answer.trim()) throw new Error('助手返回空回答，請檢查模型與登入狀態後重試');
      await updateChat(paperDirectory(paperId), (saved) => {
        appendTurn(saved, { question, answer, task: body.task || 'question', label: attachments.map((item) => item.element?.label || item.label || item.text?.label).filter(Boolean).join('\u3001') || normalizeText(body.attachmentLabel) });
        // Record how many turns this Claude session has seen so later resumes stay consistent.
        if (claudeSession) saved.claude = { ...claudeSession, turns: saved.turns.length };
      });
      emit('done', { ok: true });
    } catch (error) {
      emit('error', { message: error.message });
    } finally {
      clearInterval(heartbeat);
      requestAbort.dispose();
      res.end();
    }
    return;
  }
  if (req.method === 'DELETE' && !action) {
    await assertNoBackgroundJob(paperId);
    await rm(paperDirectory(paperId), { recursive: true, force: true });
    await rm(translationCachePath(paperId), { force: true });
    await mutateIndex((latest) => { latest.papers = latest.papers.filter((item) => item.id !== paperId); });
    sendJson(res, 200, { ok: true });
    return;
  }
  throw notFound('介面不存在');
}

async function assertNoBackgroundJob(id) {
  if (isParsing(id) || (await getPdfTranslationStatus(id)).status === 'running') {
    throw new Error('該論文仍有背景任務，請等待完成後再刪除');
  }
}

function collectFolderTree(folders, rootId) {
  const result = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (folder.parentId && result.has(folder.parentId) && !result.has(folder.id)) {
        result.add(folder.id);
        changed = true;
      }
    }
  }
  return result;
}

function cryptoRandomId() {
  return `folder-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

async function serveStatic(res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const target = path.resolve(staticRoot, `.${requested}`);
  // Check a directory boundary, not merely a shared path prefix.
  const relative = path.relative(staticRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw notFound('資源不存在');
  const content = await readFile(target);
  res.writeHead(200, { 'content-type': mimeTypes[path.extname(target)] || 'application/octet-stream' });
  res.end(content);
}

await ensureStore();
// Classify legacy records once and persist the result without re-running the parser.
await mutateIndex(async (index) => {
  for (const paper of index.papers) {
    if (paper.sourceKind) continue;
    // Older records may retain only the display title rather than the imported filename.
    const sourceName = paper.fileName || paper.title;
    let detected;
    try { detected = await detectPdfSource(sourceName, await readFile(paperPdfPath(paper.id))); }
    catch { detected = await detectPdfSource(sourceName, Buffer.alloc(0)); }
    Object.assign(paper, sourceSelection({}, detected));
  }
});
await writePromptTemplates(await getAppSettings());
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (error) {
    if (!res.headersSent) sendError(res, error);
    else res.end();
  }
});

server.requestTimeout = 15 * 60 * 1000;
server.listen(port, '127.0.0.1', () => {
  console.log(`Paper Reader running at http://127.0.0.1:${port}`);
});
