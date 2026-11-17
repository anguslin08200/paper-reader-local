import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import { renderMarkdownSource } from './markdown.js';
import { confirmImport } from './import-dialog.js';
import { initializeTour } from './onboarding.js';
import { registerTextLayer, unregisterMissingTextLayers } from './text-selection.js';
// Pure helpers share the reader's matching, export and retention rules with unit tests.
import { findTextMatches, chatMarkdown, notesMarkdown, shouldReleasePage, relativeReadTime } from './reader-utils.js';
// All attachment sources share one bounded multi-selection and ordered request format.
import { attachmentPayload, updateAttachments } from './attachment-utils.js';
import { emptyHistory, recordChange, stepHistory, sameAnnotation } from '../shared/annotation-history.js';
import './styles.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// This is a writing preference, independent of provider reasoning effort.
const ANSWER_DETAILS = { simple: '簡單', medium: '中度', detailed: '詳細' };
const ANSWER_DETAIL_KEY = 'paper-reader.answer-detail';
function savedAnswerDetail() {
  try { const value = localStorage.getItem(ANSWER_DETAIL_KEY); return Object.hasOwn(ANSWER_DETAILS, value) ? value : 'medium'; }
  catch { return 'medium'; }
}

const state = {
  folders: [],
  papers: [],
  selectedPaper: null,
  importFolderId: 'inbox',
  collapsedFolders: new Set(),
  contextFolderId: null,
  contextPaperId: null,
  pdf: null,
  renderId: 0,
  pageObserver: null,
  savePositionTimer: null,
  page: 1,
  zoom: 1,
  selectedText: '',
  cropMode: false,
  attachments: [],
  // Async crop/upload results may only update the selection that started them.
  attachmentGeneration: 0,
  followUpContext: '',
  agentBusy: false,
  answerDetail: savedAnswerDetail(),
  conversations: new Map(),
  // Browser conversation tokens scope Claude history and change on an explicit new conversation.
  conversationId: crypto.randomUUID(),
  pdfVariant: 'original',
  annotationHistory: emptyHistory(), annotationQueue: Promise.resolve(), annotationCommits: new Map(), savedAnnotations: {}, textMode: false, editingTextId: null,
  jobStatus: null,
  documentLoadId: 0,
  // One confirmation dialog handles each import, preventing overlapping selections.
  importBusy: false,
  // Search generations discard stale async scans after typing or switching PDFs.
  searchGeneration: 0,
  searchMatches: [],
  searchIndex: -1,
  searchText: new WeakMap(),
  pageRenders: new Map(),
  zoomGeneration: 0,
};

// The assistant panel can live in a separate Picture-in-Picture window; look ids up in both documents.
let pipDocument = null;
const $ = (id) => document.getElementById(id) || pipDocument?.getElementById(id);

function showToast(message) {
  // Mirror toasts into the popped-out assistant window so feedback is visible on either monitor.
  if (pipDocument) {
    let pipToast = pipDocument.getElementById('pipToast');
    if (!pipToast) { pipToast = Object.assign(pipDocument.createElement('div'), { id: 'pipToast', className: 'toast' }); pipDocument.body.append(pipToast); }
    pipToast.textContent = message; pipToast.hidden = false;
    window.clearTimeout(showToast.pipTimer);
    showToast.pipTimer = window.setTimeout(() => { pipToast.hidden = true; }, 4200);
  }
  const toast = document.getElementById('toast');
  toast.classList.remove('has-action');
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { toast.hidden = true; }, 4200);
}

async function request(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `請求失敗：HTTP ${response.status}`);
  return payload;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function renderLibrary() {
  const tree = $('libraryTree');
  // Searching expands matching folders without altering the user's collapsed state.
  const query = $('librarySearch').value.trim().toLocaleLowerCase();
  const matchingPapers = state.papers.filter((paper) => [paper.title, ...(paper.authors || [])].join(' ').toLocaleLowerCase().includes(query));
  tree.innerHTML = '';
  const foldersByParent = new Map();
  for (const folder of state.folders) {
    const parent = folder.parentId || null;
    if (!foldersByParent.has(parent)) foldersByParent.set(parent, []);
    foldersByParent.get(parent).push(folder);
  }

  const renderFolder = (folder, depth) => {
    const node = document.createElement('div');
    node.className = 'folder-node';
    node.style.setProperty('--depth', depth);
    const collapsed = !query && state.collapsedFolders.has(folder.id);
    const title = document.createElement('div');
    title.className = `folder-title${state.importFolderId === folder.id ? ' selected-folder' : ''}`;
    title.innerHTML = `<span class="folder-caret">${collapsed ? '▸' : '▾'}</span>📁 ${escapeHtml(folder.name)}`;
    title.title = '左鍵展開/收起並選為匯入位置，右鍵開啟資料夾選單';
    title.addEventListener('click', () => {
      state.importFolderId = folder.id;
      if (collapsed) state.collapsedFolders.delete(folder.id);
      else state.collapsedFolders.add(folder.id);
      renderLibrary();
    });
    title.addEventListener('contextmenu', (event) => {
      state.contextFolderId = folder.id;
      showMenu($('folderMenu'), event);
    });
    node.append(title);

    const children = document.createElement('div');
    children.className = 'folder-children';
    children.hidden = collapsed;
    for (const paper of matchingPapers.filter((item) => item.folderId === folder.id)) {
      const button = document.createElement('button');
      button.className = `paper-item${state.selectedPaper?.id === paper.id ? ' selected' : ''}`;
      const firstAuthor = paper.authors?.length > 1 ? `${paper.authors[0]} 等` : paper.authors?.[0];
      button.innerHTML = `<strong>${escapeHtml(paper.title)}</strong><small>${escapeHtml([firstAuthor, paper.year, parseLabel(paper.parseStatus?.status)].filter(Boolean).join(' · ') || '本機匯入')}</small><small class="last-read">${escapeHtml(relativeReadTime(paper.lastOpenedAt))}</small>`;
      button.title = paper.title;
      button.addEventListener('click', () => selectPaper(paper));
      button.addEventListener('contextmenu', (event) => {
        state.contextPaperId = paper.id;
        $('paperMenu').querySelector('[data-action="mark-translated"]').hidden = paper.sourceKind === 'translated';
        $('paperMenu').querySelector('[data-action="mark-original"]').hidden = paper.sourceKind !== 'translated';
        showMenu($('paperMenu'), event);
      });
      children.append(button);
    }
    for (const child of foldersByParent.get(folder.id) || []) {
      const childNode = renderFolder(child, depth + 1);
      if (childNode) children.append(childNode);
    }
    if (query && !children.children.length) return null;
    node.append(children);
    return node;
  };

  for (const folder of foldersByParent.get(null) || []) {
    const node = renderFolder(folder, 0);
    if (node) tree.append(node);
  }
  if (!state.folders.length && !state.papers.length) tree.textContent = '還沒有論文';
  if (query && !matchingPapers.length) tree.textContent = '沒有符合的論文';
  $('libraryStatus').textContent = query ? `${matchingPapers.length} / ${state.papers.length} 篇論文` : `${state.papers.length} 篇論文`;
}

function showMenu(menu, event) {
  event.preventDefault();
  hideMenus();
  menu.hidden = false;
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8)}px`;
}

function hideMenus() {
  $('folderMenu').hidden = true;
  $('paperMenu').hidden = true;
}

async function loadLibrary() {
  const library = await request('/api/library');
  state.folders = library.folders;
  state.papers = library.papers;
  // Polling also refreshes source labels after existing records have been corrected.
  if (state.selectedPaper) state.selectedPaper = state.papers.find((paper) => paper.id === state.selectedPaper.id) || state.selectedPaper;
  if (!state.folders.some((folder) => folder.id === state.importFolderId)) state.importFolderId = 'inbox';
  if (state.selectedPaper && !state.papers.some((paper) => paper.id === state.selectedPaper.id)) clearReader();
  renderLibrary();
}

function clearReader() {
  // Queue an active edit before detaching the current page.
  if (state.editingTextId) commitTextAnnotation(state.editingTextId);
  clearAttachment();
  closePdfSearch();
  cancelPageRenders();
  ++state.documentLoadId;
  ++state.renderId;
  state.pdf?.destroy().catch(() => {});
  state.selectedPaper = null;
  state.annotationHistory = emptyHistory(); state.savedAnnotations = {}; state.editingTextId = null;
  state.annotations = []; state.textMode = false;
  $('textAnnotationToolbar').hidden = true;
  updateAnnotationControls();
  state.pdf = null;
  state.selectedText = '';
  state.followUpContext = '';
  state.pageObserver?.disconnect();
  $('pdfPages').replaceChildren();
  $('emptyReader').hidden = false;
  $('pdfPages').hidden = true;
  $('translationPanel').hidden = true;
  $('paperTitle').textContent = 'Paper Reader';
  $('paperMeta').textContent = '選擇一篇論文開始閱讀';
  $('pageCount').textContent = '—';
  $('parseStatus').textContent = '未選擇論文';
  $('pdfTranslationStatus').textContent = '';
  $('jobDetails').hidden = true;
  $('sourceNotice').hidden = true;
  $('translatePdf').disabled = true;
  $('pdfVariant').replaceChildren();
  updateContextChips();
}

async function selectPaper(paper) {
  // Commit before replacing the page that owns the editable box.
  if (state.editingTextId && !(await commitTextAnnotation(state.editingTextId))) return;
  await state.annotationQueue;
  if (state.agentBusy) return showToast('請等待目前回答完成後切換論文');
  const loadId = ++state.documentLoadId;
  closePdfSearch();
  cancelPageRenders();
  flushReadingPosition();
  ++state.renderId;
  state.pageObserver?.disconnect();
  state.pdf?.destroy().catch(() => {});
  state.selectedPaper = paper;
  state.pdf = null;
  // Clear the previous paper immediately so its pages never appear under the new title.
  $('pdfPages').replaceChildren();
  state.page = paper.currentPage || 1;
  // Zoom belongs to each paper and survives browser restarts.
  try { state.zoom = Math.min(4, Math.max(.15, Number(localStorage.getItem(`paper-reader.zoom.${paper.id}`)) || 1)); }
  catch { state.zoom = 1; }
  state.selectedText = '';
  // Figure list and attachment belong to the previous paper.
  state.elements = []; state.elementsFor = null;
  clearAttachment();
  // Conversations are stored per paper on the server and restored here (memory survives reloads).
  state.followUpContext = '';
  $('chatMessages').replaceChildren();
  state.chatLoading = true;
  loadChat(paper.id, loadId);
  state.annotations = [];
  state.annotationHistory = emptyHistory(); state.annotationQueue = Promise.resolve(); state.savedAnnotations = {}; state.editingTextId = null; state.textMode = false;
  updateAnnotationControls();
  renderNotes();
  closeHighlightPopover();
  loadAnnotations(paper.id);
  // A translated upload occupies its actual variant, even though the disk name is original.pdf.
  state.pdfVariant = paper.sourceKind === 'translated' ? (paper.translatedVariant || 'bilingual') : 'original';
  updatePdfVariants({ [state.pdfVariant]: true });
  $('pdfVariant').disabled = false;
  state.jobStatus = null;
  renderLibrary();
  updateContextChips();
  $('paperTitle').textContent = paper.title;
  $('paperMeta').textContent = [paper.authors?.slice(0, 3).join(', '), paper.year, paper.arxivId].filter(Boolean).join(' · ') || '本地論文';
  $('emptyReader').hidden = true;
  $('pdfPages').hidden = false;
  $('translationPanel').hidden = true;
  updateSourceNotice();
  try {
    const pdf = await pdfjsLib.getDocument(`${paper.pdfUrl}?variant=${state.pdfVariant}`).promise;
    // A slower previous selection must not replace a newer paper's viewer.
    if (loadId !== state.documentLoadId) { await pdf.destroy(); return; }
    state.pdf = pdf;
    $('pageCount').textContent = state.pdf.numPages;
    await renderDocument();
    if (loadId !== state.documentLoadId) return;
    scrollToPage(state.page);
    saveReadingPosition();
    await refreshJobStatus();
    await loadElements();
  } catch (error) {
    if (loadId === state.documentLoadId) showToast(`PDF 載入失敗：${error.message}`);
  }
}

async function renderDocument() {
  const renderId = ++state.renderId;
  cancelPageRenders();
  const pdf = state.pdf;
  const scale = state.zoom * 1.35;
  const container = $('pdfPages');
  state.pageObserver?.disconnect();
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const viewport = (await pdf.getPage(pageNumber)).getViewport({ scale });
    if (renderId !== state.renderId) return;
    const element = document.createElement('div');
    element.className = 'pdf-page';
    element.dataset.page = pageNumber;
    element.style.width = `${Math.floor(viewport.width)}px`;
    element.style.height = `${Math.floor(viewport.height)}px`;
    pages.push(element);
  }
  container.replaceChildren(...pages);
  unregisterMissingTextLayers();
  state.pageObserver = new IntersectionObserver((entries) => {
    // An observer notification queued by a previous zoom must not render the old document.
    if (renderId !== state.renderId || state.pdf !== pdf) return;
    for (const entry of entries) {
      if (!entry.isIntersecting || entry.target.dataset.rendered) continue;
      ensurePageRendered(entry.target);
    }
  }, { root: $('readerStage'), rootMargin: '800px 0px' });
  for (const element of pages) state.pageObserver.observe(element);
  $('zoomLabel').textContent = `${Math.round(state.zoom * 100)}%`;
}

async function renderPdfPage(pdf, element, scale) {
  // Track both tasks so released pages cannot append an old text layer after redrawing.
  const job = { cancelled: false, canvasTask: null, textTask: null, promise: null };
  state.pageRenders.set(element, job);
  element.dataset.rendered = 'true';
  try {
  const page = await pdf.getPage(Number(element.dataset.page));
  if (job.cancelled || !element.isConnected || state.pdf !== pdf) return;
  const viewport = page.getViewport({ scale });
  // Render at >= 2 device pixels per CSS pixel: on 100%/125% displays and zoomed-out (e.g. bilingual
  // side-by-side at ~60%) pages, supersampling keeps small glyphs legible instead of broken/blurry.
  // Capped at ~16.7M pixels per page to bound memory on very large pages.
  const MAX_CANVAS_PIXELS = 16777216;
  const desired = Math.max(window.devicePixelRatio || 1, 2);
  const outputScale = Math.min(desired, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  const textLayer = document.createElement('div');
  textLayer.className = 'textLayer';
  textLayer.style.setProperty('--total-scale-factor', viewport.scale);
  element.append(canvas, textLayer);
  job.canvasTask = page.render({
    canvasContext: canvas.getContext('2d', { alpha: false }),
    viewport,
    transform: [outputScale, 0, 0, outputScale, 0, 0],
  });
  await job.canvasTask.promise;
  const textContent = await page.getTextContent();
  if (job.cancelled || !element.isConnected) return;
  job.textTask = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayer, viewport });
  await job.textTask.render();
  if (job.cancelled || !element.isConnected) return;
  // Text divs align with text items, including empty items; keep raw offsets for cross-span matches.
  let offset = 0; let index = 0;
  element.searchSpans = textContent.items.filter((item) => typeof item.str === 'string').map((item) => {
    const span = { node: job.textTask.textDivs[index++], start: offset, end: offset + item.str.length };
    offset = span.end + (item.hasEOL ? 1 : 0);
    return span;
  });
  // Keeps drag selections to the text actually covered (pdf.js viewer endOfContent behavior).
  registerTextLayer(textLayer);
  // Saved highlights for this page and PDF version.
  renderPageHighlights(element);
  renderSearchHighlights(element);
  } catch (error) {
    if (!job.cancelled && error.name !== 'RenderingCancelledException' && error.name !== 'AbortException') {
      releasePage(element);
      throw error;
    }
  } finally {
    if (state.pageRenders.get(element) === job) state.pageRenders.delete(element);
  }
}

// Removing a canvas also clears its backing bitmap, not only its DOM reference.
function releasePage(element) {
  const job = state.pageRenders.get(element);
  if (job) { job.cancelled = true; job.canvasTask?.cancel(); job.textTask?.cancel(); state.pageRenders.delete(element); }
  for (const canvas of element.querySelectorAll('canvas')) { canvas.width = 0; canvas.height = 0; }
  element.replaceChildren();
  delete element.dataset.rendered;
  delete element.searchSpans;
}

function cancelPageRenders() {
  for (const page of $('pdfPages').children) releasePage(page);
  unregisterMissingTextLayers();
}

function ensurePageRendered(element) {
  if (!element?.isConnected || !state.pdf) return Promise.resolve();
  // At very small zooms the prefetch margin spans many pages; still bound resident canvases.
  const rect = element.getBoundingClientRect(); const bounds = $('readerStage').getBoundingClientRect();
  if (shouldReleasePage(Number(element.dataset.page), state.page) && (rect.bottom < bounds.top || rect.top > bounds.bottom)) return Promise.resolve();
  const existing = state.pageRenders.get(element);
  if (existing) return existing.promise;
  if (element.dataset.rendered) return Promise.resolve();
  const promise = renderPdfPage(state.pdf, element, state.zoom * 1.35).catch((error) => showToast(`PDF 頁面渲染失敗：${error.message}`));
  const job = state.pageRenders.get(element);
  if (job) job.promise = promise;
  return promise;
}

function maintainPageCanvases() {
  if (!state.pdf) return;
  const bounds = $('readerStage').getBoundingClientRect();
  for (const page of $('pdfPages').children) {
    const rect = page.getBoundingClientRect();
    const visible = rect.bottom >= bounds.top && rect.top <= bounds.bottom;
    if (!visible && shouldReleasePage(Number(page.dataset.page), state.page)) releasePage(page);
    else if (visible) ensurePageRendered(page);
  }
  unregisterMissingTextLayers();
}

function scrollToPage(pageNumber) {
  const target = Math.min(Math.max(1, pageNumber), state.pdf.numPages);
  // Scroll only the reader pane; scrollIntoView also shifted the whole app shell upward.
  const stage = $('readerStage');
  const pageElement = $('pdfPages').children[target - 1];
  stage.scrollTop += pageElement.getBoundingClientRect().top - stage.getBoundingClientRect().top - 12;
  setCurrentPage(target);
  maintainPageCanvases();
}

function updateCurrentPageFromScroll() {
  const stage = $('readerStage');
  const line = stage.getBoundingClientRect().top + stage.clientHeight / 3;
  const current = [...$('pdfPages').children].find((element) => element.getBoundingClientRect().bottom >= line);
  if (current) setCurrentPage(Number(current.dataset.page));
  maintainPageCanvases();
}

function setCurrentPage(pageNumber) {
  $('pageInput').value = pageNumber;
  if (pageNumber === state.page) return;
  state.page = pageNumber;
  saveReadingPosition();
}

function saveReadingPosition() {
  // Also save on open: visiting page 1 still counts as reading this paper.
  if (!state.selectedPaper) return;
  const paperId = state.selectedPaper.id;
  const pageNumber = state.page;
  state.selectedPaper.currentPage = pageNumber;
  state.selectedPaper.lastOpenedAt = new Date().toISOString();
  try { localStorage.setItem('paper-reader.last-reading', JSON.stringify({ id: paperId, page: pageNumber })); } catch { /* Server persistence still works. */ }
  window.clearTimeout(state.savePositionTimer);
  state.pendingPosition = { paperId, pageNumber };
  state.savePositionTimer = window.setTimeout(flushReadingPosition, 600);
}

function flushReadingPosition() {
  // Flush before changing papers so the final debounced page of the old paper is not lost.
  window.clearTimeout(state.savePositionTimer);
  const pending = state.pendingPosition;
  state.pendingPosition = null;
  if (!pending) return;
  request(`/api/papers/${pending.paperId}/position`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page: pending.pageNumber }), keepalive: true,
  }).catch((error) => showToast(`閱讀位置儲存失敗：${error.message}`));
}

async function changeZoom(delta) {
  if (!state.pdf) return;
  await setZoom(state.zoom + delta);
}

async function currentPageText() {
  const page = await state.pdf.getPage(state.page);
  return (await page.getTextContent()).items.map((item) => item.str).join(' ');
}

function trackPdfSelection() {
  const selection = window.getSelection();
  if (!selection.rangeCount || !$('pdfPages').contains(selection.anchorNode)) return;
  state.selectedText = selection.toString().trim();
  updateContextChips();
}

function setCropMode(enabled) {
  state.cropMode = enabled;
  // A prior text selection must not be reattached by mouseup after a crop finishes.
  if (enabled) window.getSelection()?.removeAllRanges();
  $('pdfPages').classList.toggle('crop-mode', enabled);
  $('cropToggle').classList.toggle('active', enabled);
  // Show explicit drag/Esc instructions while crop mode is on.
  $('cropHint').hidden = !enabled;
}

async function translateSelection(text = state.selectedText, attachment = state.attachments.find((item) => item.text === text)) {
  if (!state.selectedPaper) return showToast('請先選擇一篇論文');
  if (!text) return showToast('請先在 PDF 頁面中選中文字');
  $('translationPanel').hidden = false;
  // Bilingual pages already contain the other language: show the matching paragraph instantly.
  const counterpart = attachment?.counterpart;
  if (counterpart) {
    $('translationResult').textContent = counterpart;
    $('translationStatus').textContent = attachment.counterpartLang === 'en' ? '雙語對照：英文原文' : '雙語對照：中文譯文';
    return;
  }
  $('translationStatus').textContent = '翻譯中…';
  $('translationResult').textContent = '';
  try {
    const result = await request(`/api/papers/${state.selectedPaper.id}/translate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, targetLanguage: '繁體中文（台灣）', sourceLanguage: 'auto', provider: $('selectionProvider').value || undefined }),
    });
    $('translationResult').textContent = result.result;
    $('translationStatus').textContent = result.cached ? '快取命中' : '模型翻譯';
  } catch (error) {
    $('translationStatus').textContent = '失敗';
    showToast(error.message);
  }
}

function renderMarkdown(text) {
  return DOMPurify.sanitize(renderMarkdownSource(text), {
    ADD_TAGS: ['annotation', 'math', 'menclose', 'merror', 'mfenced', 'mfrac', 'mi', 'mmultiscripts', 'mn', 'mo', 'mover', 'mpadded', 'mphantom', 'mroot', 'mrow', 'ms', 'mspace', 'msqrt', 'mstyle', 'msub', 'msubsup', 'msup', 'mtable', 'mtd', 'mtext', 'mtr', 'munder', 'munderover', 'semantics'],
    ADD_ATTR: ['aria-hidden', 'class', 'encoding', 'style', 'xmlns'],
  });
}

function addMessage(role, text = '', { scroll = true } = {}) {
  const message = document.createElement('div');
  message.className = `message ${role}`;
  const content = document.createElement(role === 'assistant' ? 'div' : 'pre');
  if (role === 'assistant') content.className = 'markdown';
  content.textContent = text;
  // User messages and assistant source are kept independently of rendered Markdown for export.
  if (role === 'user') content.dataset.source = text;
  message.append(content);

  let followUpButton = null;
  if (role === 'assistant') {
    const messagePaperId = state.selectedPaper?.id;
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    followUpButton = document.createElement('button');
    followUpButton.type = 'button';
    followUpButton.className = 'message-action';
    followUpButton.textContent = '追問';
    followUpButton.hidden = true;
    followUpButton.addEventListener('click', () => {
      if (state.selectedPaper?.id !== messagePaperId) return showToast('請切回生成該回答的論文後再追問');
      // The conversation already remembers earlier turns; just focus the input for a follow-up.
      $('chatInput').focus();
      showToast('對話有記憶，直接輸入追問即可');
    });
    actions.append(followUpButton);
    const copyButton = Object.assign(document.createElement('button'), { type: 'button', className: 'message-action copy-answer', textContent: '複製' });
    copyButton.addEventListener('click', async () => {
      try {
        await copyMarkdown(content.dataset.answer || '', copyButton.ownerDocument);
        showToast('已複製 Markdown 原文');
      } catch (error) { showToast(`複製失敗：${error.message}`); }
    });
    actions.append(copyButton);
    message.append(actions);
  }

  $('chatMessages').append(message);
  if (scroll) $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
  return { message, content, followUpButton };
}

// All lookups follow the moved assistant DOM, so streaming also works in the pop-out window.
function updateLatestButton() {
  const chat = $('chatMessages');
  $('jumpToLatest').hidden = chat.hidden || !chat.clientHeight || chat.scrollHeight - chat.clientHeight - chat.scrollTop <= 24;
}
function anchorNewQuestion(user, assistant) {
  const chat = $('chatMessages');
  for (const old of chat.querySelectorAll('[data-reading-anchor]')) { old.style.minHeight = ''; delete old.dataset.readingAnchor; }
  const style = chat.ownerDocument.defaultView.getComputedStyle(chat);
  const paddingTop = parseFloat(style.paddingTop) || 0;
  // Reserve space for a short answer too, allowing this question to align with the viewport top.
  assistant.dataset.readingAnchor = 'true';
  assistant.style.minHeight = `${Math.max(0, chat.clientHeight - user.offsetHeight - paddingTop - (parseFloat(style.paddingBottom) || 0) - 20)}px`;
  chat.scrollTop += user.getBoundingClientRect().top - chat.getBoundingClientRect().top - paddingTop;
  updateLatestButton();
}
$('jumpToLatest').addEventListener('click', () => {
  const chat = $('chatMessages'); chat.scrollTop = chat.scrollHeight; updateLatestButton();
});
$('chatMessages').addEventListener('scroll', updateLatestButton, { passive: true });
new ResizeObserver(updateLatestButton).observe($('chatMessages'));

function setAnswerDetail(detail) {
  if (!Object.hasOwn(ANSWER_DETAILS, detail)) return;
  state.answerDetail = detail;
  try { localStorage.setItem(ANSWER_DETAIL_KEY, detail); } catch { /* Optional browser persistence. */ }
  updateAnswerDetail();
}
function updateAnswerDetail() {
  $('answerDetailBadge').textContent = `深度：${ANSWER_DETAILS[state.answerDetail]}`;
  for (const button of $('attachmentActions').querySelectorAll('[data-answer-detail]')) button.setAttribute('aria-pressed', String(button.dataset.answerDetail === state.answerDetail));
}
function detailSegment() {
  const segment = document.createElement('span'); segment.className = 'detail-segment';
  segment.setAttribute('role', 'group'); segment.setAttribute('aria-label', '解釋深度');
  for (const [detail, text] of Object.entries(ANSWER_DETAILS)) {
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: text });
    button.dataset.answerDetail = detail; button.title = `${text}說明`;
    button.setAttribute('aria-pressed', String(state.answerDetail === detail));
    button.addEventListener('click', () => setAnswerDetail(detail)); segment.append(button);
  }
  return segment;
}
$('answerDetailBadge').addEventListener('click', () => {
  const levels = Object.keys(ANSWER_DETAILS); setAnswerDetail(levels[(levels.indexOf(state.answerDetail) + 1) % levels.length]);
});
updateAnswerDetail();

function updateContextChips() {
  const chips = $('contextChips');
  chips.innerHTML = '';
  // Every explicit item is shown in the attachment list; no hidden selection is sent implicitly.
  if (state.followUpContext) chips.append(chip('已附加上一條回答'));
  chips.hidden = !chips.children.length;
}

function chip(text) {
  const element = document.createElement('span');
  element.className = 'context-chip';
  element.textContent = text;
  return element;
}

async function sendQuestion(question, task = 'question', { exampleLevel } = {}) {
  if (!state.selectedPaper) return showToast('請先選擇一篇論文');
  if (!state.pdf) return showToast('PDF 尚未載入完成');
  if (state.chatLoading) return showToast('對話紀錄載入中，請稍候');
  if (!question.trim()) return;
  if (state.agentBusy) return showToast('Agent 正在回答');
  // Typed questions can also be submitted while notes or the element list is open.
  showAssistantTab('chat');
  state.agentBusy = true;
  const controller = new AbortController();
  state.answerController = controller;
  $('stopAnswer').hidden = false;
  $('agentStatus').textContent = '思考中';
  $('agentStatus').classList.add('busy');
  const submittedAttachments = [...state.attachments];
  const submittedText = state.selectedText;
  const attachments = attachmentPayload(submittedAttachments);
  const detail = state.answerDetail;
  const userMessage = addMessage('user', attachments.attachmentLabel ? `［附上：${attachments.attachmentLabel}］\n${question}` : question, { scroll: false });
  const assistantMessage = addMessage('assistant', '', { scroll: false });
  anchorNewQuestion(userMessage.message, assistantMessage.message);
  const assistant = assistantMessage.content;
  let answer = '';
  let completed = false;
  try {
    const payload = {
      question,
      task,
      detail,
      ...(exampleLevel ? { exampleLevel } : {}),
      page: state.page,
      pageText: await currentPageText(),
      previousAnswer: state.followUpContext,
      // Capture before awaits: the sent request must match the visible selection at submission.
      ...attachments,
    };
    const response = await fetch(`/api/papers/${state.selectedPaper.id}/ask`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`Agent 請求失敗：HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const raw of events) {
        const eventName = raw.match(/^event: (.+)$/m)?.[1];
        const data = raw.match(/^data: (.+)$/m)?.[1];
        if (!data) continue;
        const parsed = JSON.parse(data);
        if (eventName === 'token') {
          answer += parsed.text;
          assistant.dataset.answer = answer;
          assistant.innerHTML = renderMarkdown(answer);
          updateLatestButton();
        }
        if (eventName === 'done') completed = true;
        // Surface provider reconnects instead of leaving the reader at an unexplained busy state.
        if (eventName === 'status') $('agentStatus').textContent = parsed.message;
        if (eventName === 'error') throw new Error(parsed.message);
      }
    }
    if (completed && answer.trim()) {
      assistantMessage.followUpButton.hidden = false;
      // The server saved this turn; later questions automatically include the conversation.
      state.chatTurns = (state.chatTurns || 0) + 1;
      updateMemoryNote();
    } else if (!completed) throw new Error('助手連線提前結束，請重試');
  } catch (error) {
    // Preserve a partial reply on stop, allowing its Markdown to be copied or exported.
    if (controller.signal.aborted) {
      if (!answer) assistant.textContent = '已停止回答';
      showToast('已停止回答');
    } else {
      if (!answer) assistant.textContent = `助手錯誤：${error.message}`;
      showToast(error.message);
    }
  } finally {
    state.agentBusy = false;
    state.answerController = null;
    $('stopAnswer').hidden = true;
    $('agentStatus').textContent = '就緒';
    $('agentStatus').classList.remove('busy');
    // Each attachment applies to one question; the figure list stays available for the next one.
    state.attachments = state.attachments.filter((item) => !submittedAttachments.includes(item));
    renderAttachments();
    if (state.selectedText === submittedText) state.selectedText = state.attachments.findLast((item) => item.text)?.text || '';
    updateLatestButton();
  }
}

function setupCropSelection() {
  const pages = $('pdfPages');
  const cropBox = document.createElement('div');
  cropBox.className = 'crop-box';
  let start = null;
  const cropRect = (event) => {
    const x = Math.min(Math.max(event.clientX - start.rect.left, 0), start.rect.width);
    const y = Math.min(Math.max(event.clientY - start.rect.top, 0), start.rect.height);
    return { left: Math.min(start.x, x), top: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) };
  };
  pages.addEventListener('pointerdown', (event) => {
    const pageElement = event.target.closest('.pdf-page');
    const canvas = pageElement?.querySelector('canvas');
    if (!state.cropMode || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    start = { x: event.clientX - rect.left, y: event.clientY - rect.top, rect, canvas, additive: event.ctrlKey || event.metaKey };
    Object.assign(cropBox.style, { left: `${start.x}px`, top: `${start.y}px`, width: '0px', height: '0px' });
    pageElement.append(cropBox);
    pages.setPointerCapture(event.pointerId);
  });
  pages.addEventListener('pointermove', (event) => {
    if (!start) return;
    const { left, top, width, height } = cropRect(event);
    Object.assign(cropBox.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  });
  pages.addEventListener('pointerup', (event) => {
    if (!start) return;
    const { rect, canvas, additive } = start;
    const { left, top, width, height } = cropRect(event);
    start = null;
    cropBox.remove();
    if (width < 10 || height < 10) return;
    setCropMode(false);
    // Normalized page coordinates; the crop is re-rendered at high resolution from the PDF itself.
    const pageNumber = Number(canvas.closest('.pdf-page').dataset.page);
    handleCrop(pageNumber, { x: left / rect.width, y: top / rect.height, w: width / rect.width, h: height / rect.height }, additive || event.ctrlKey || event.metaKey);
  });
}

async function readFirstPageText(file) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  try {
    const content = await (await pdf.getPage(1)).getTextContent();
    return content.items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join('');
  } finally {
    await pdf.destroy();
  }
}

async function importLocalFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (state.importBusy) { event.target.value = ''; return; }
  state.importBusy = true;
  try {
    // Start the dialog immediately; server-side extraction checks the first two pages.
    const dataPromise = readAsDataUrl(file);
    const options = await confirmImport({ fileName: file.name, detect: async () => request('/api/papers/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, data: await dataPromise }),
    }) });
    if (!options) return;
    $('libraryStatus').textContent = '正在匯入論文…';
    const [data, firstPageText] = await Promise.all([dataPromise, readFirstPageText(file).catch(() => '')]);
    const result = await request('/api/papers/upload', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, data, firstPageText, folderId: state.importFolderId || 'inbox', ...options }),
    });
    if (result.metadataError) showToast(`論文已匯入，但未能識別標題和作者：${result.metadataError}`);
    await loadLibrary();
    await selectPaper(result);
  } catch (error) {
    showToast(error.message);
    renderLibrary();
  } finally {
    state.importBusy = false;
    event.target.value = '';
  }
}

async function openSettings() {
  try {
    const settings = await request('/api/settings');
    $('translationBaseUrl').value = settings.translation.baseUrl;
    $('translationModel').value = settings.translation.model;
    $('translationProvider').value = settings.translation.provider;
    $('translationClaudeModel').value = settings.translation.claudeModel;
    $('translationApiKey').value = '';
    $('translationApiKey').placeholder = settings.translation.apiKeyConfigured ? '已配置，留空保持' : '請輸入 API Key';
    $('agentModel').value = settings.agent.model;
    $('agentProvider').value = settings.agent.provider;
    $('claudeModel').value = settings.agent.claudeModel;
    $('claudeEffort').value = settings.agent.claudeEffort || '';
    $('agentThinking').value = settings.agent.thinking;
    $('summaryPrompt').value = settings.prompts.summary;
    $('sectionPrompt').value = settings.prompts.section;
    $('figurePrompt').value = settings.prompts.figure;
    $('questionPrompt').value = settings.prompts.question;
    // Element templates are edited alongside the original four.
    for (const name of ['table', 'algorithm', 'equation', 'example', 'passage', 'term', 'compare', 'detailSimple', 'detailDetailed', 'exampleSimple', 'exampleFull']) $(`${name}Prompt`).value = settings.prompts[name] || '';
    for (const field of ['parserProvider', 'retrievalProvider', 'mineruExecutable', 'mineruHome', 'mineruCacheDirectory', 'parserBaseUrl', 'embeddingBaseUrl', 'embeddingModel']) $(field).value = settings.rag[field];
    for (const field of ['parserApiKey', 'embeddingApiKey']) {
      $(field).value = '';
      $(field).placeholder = settings.rag[`${field}Configured`] ? '已配置，留空保持' : '未配置（本機模式不需要）';
    }
    $('pdfTranslationProvider').value = settings.pdfTranslation.provider;
    $('pdfTranslationScript').value = settings.pdfTranslation.scriptPath;
    $('pdfTranslationModel').value = settings.pdfTranslation.model;
    $('pdfTranslationEffort').value = settings.pdfTranslation.effort;
    $('pdfTranslationParallel').value = settings.pdfTranslation.parallel;
    $('annotationExportDirectory').value = settings.exportDirectory || '';
    $('settingsStatus').textContent = '';
    $('appShell').hidden = true;
    $('settingsView').hidden = false;
    updateProviderControls();
    loadAgentStatus();
    if (settings.agent.provider === 'codex') refreshModels();
  } catch (error) { showToast(error.message); }
}

async function saveSettings(event) {
  event.preventDefault();
  const translation = { provider: $('translationProvider').value, baseUrl: $('translationBaseUrl').value.trim(), model: $('translationModel').value.trim(), claudeModel: $('translationClaudeModel').value.trim() || 'sonnet' };
  if ($('translationApiKey').value.trim()) translation.apiKey = $('translationApiKey').value.trim();
  const rag = {};
  for (const field of ['parserProvider', 'retrievalProvider', 'mineruExecutable', 'mineruHome', 'mineruCacheDirectory', 'parserBaseUrl', 'embeddingBaseUrl', 'embeddingModel']) rag[field] = $(field).value.trim();
  for (const field of ['parserApiKey', 'embeddingApiKey']) if ($(field).value.trim()) rag[field] = $(field).value.trim();
  try {
    await request('/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        translation,
        exportDirectory: $('annotationExportDirectory').value.trim(),
        rag,
        agent: { provider: $('agentProvider').value, model: $('agentModel').value.trim(), thinking: $('agentThinking').value, claudeModel: $('claudeModel').value.trim() || 'sonnet', claudeEffort: $('claudeEffort').value },
        pdfTranslation: { provider: $('pdfTranslationProvider').value, scriptPath: $('pdfTranslationScript').value.trim(), model: $('pdfTranslationModel').value.trim(), effort: $('pdfTranslationEffort').value.trim(), parallel: Number($('pdfTranslationParallel').value) },
        prompts: {
          summary: $('summaryPrompt').value.trim(),
          section: $('sectionPrompt').value.trim(),
          figure: $('figurePrompt').value.trim(),
          question: $('questionPrompt').value.trim(),
          ...Object.fromEntries(['table', 'algorithm', 'equation', 'example', 'passage', 'term', 'compare'].map((name) => [name, $(`${name}Prompt`).value.trim()]).filter(([, value]) => value)),
          // Clearing a modifier restores its backend default rather than retaining an old custom value.
          ...Object.fromEntries(['detailSimple', 'detailDetailed', 'exampleSimple', 'exampleFull'].map((name) => [name, $(`${name}Prompt`).value.trim()])),
        },
      }),
    });
    $('settingsStatus').textContent = '已儲存';
    loadModelBadge();
  } catch (error) {
    $('settingsStatus').textContent = '儲存失敗';
    showToast(error.message);
  }
}

function parseLabel(status) {
  return ({ running: '解析中', completed: '解析完成', failed: '解析失敗', idle: '未解析' })[status] || '';
}

function updateSourceNotice() {
  const translated = state.selectedPaper?.sourceKind === 'translated';
  $('sourceNotice').hidden = !translated;
  $('sourceNotice').textContent = translated ? '此為已翻譯版，無需再翻譯。解析與問答品質可能較原文差，建議上傳英文原文。' : '';
  $('translatePdf').disabled = !state.selectedPaper || translated || state.jobStatus?.translation.status === 'running';
  $('translatePdf').title = translated ? '此為已翻譯版，無需再翻譯' : '';
}

function updatePdfVariants(outputs) {
  // Only present files appear in the menu; generated variants arrive via status polling.
  const labels = { original: '原文', chinese: '中文', bilingual: '雙語' };
  $('pdfVariant').replaceChildren(...Object.entries(labels).filter(([key]) => outputs?.[key]).map(([value, textContent]) => Object.assign(document.createElement('option'), { value, textContent })));
  $('pdfVariant').value = state.pdfVariant;
}

async function refreshJobStatus() {
  const id = state.selectedPaper?.id;
  if (!id) return;
  const status = await request(`/api/papers/${id}/status`);
  if (state.selectedPaper?.id !== id) return;
  const previous = state.jobStatus;
  state.jobStatus = status;
  $('parseStatus').textContent = parseLabel(status.parse.status);
  $('parseStatus').classList.toggle('failed', status.parse.status === 'failed');
  $('parseStatus').title = status.parse.error || '';
  $('retryParse').disabled = status.parse.status === 'running';
  const translation = status.translation;
  updateSourceNotice();
  $('pdfTranslationStatus').textContent = ({ idle: '', running: '整篇翻譯中…', completed: '譯文已完成', failed: '整篇翻譯失敗' })[translation.status];
  $('pdfTranslationStatus').classList.toggle('failed', translation.status === 'failed');
  updatePdfVariants(translation.outputs);
  // Populate the figure list as soon as background parsing finishes.
  if (status.parse.status === 'completed' && previous?.parse.status && previous.parse.status !== 'completed') loadElements();
  const details = [status.parse.error, translation.error, translation.log].filter(Boolean).join('\n\n');
  $('jobLog').textContent = details;
  $('jobDetails').hidden = !details;
  // Show terminal failures once and retain their details after the toast disappears.
  for (const key of ['parse', 'translation']) {
    if (status[key].status === 'failed' && previous?.[key].status !== 'failed') {
      showToast(status[key].error || '背景任務失敗，請檢視任務詳情');
      $('jobDetails').open = true;
    }
  }
}

async function retryParse() {
  if (!state.selectedPaper) return showToast('請先選擇一篇論文');
  try {
    await request(`/api/papers/${state.selectedPaper.id}/reindex`, { method: 'POST' });
    await refreshJobStatus();
  } catch (error) { showToast(error.message); }
}

async function translateWholePdf() {
  if (!state.selectedPaper) return showToast('請先選擇一篇論文');
  if (state.selectedPaper.sourceKind === 'translated') return showToast('此為已翻譯版，無需再翻譯');
  try {
    await request(`/api/papers/${state.selectedPaper.id}/translate-pdf`, { method: 'POST' });
    await refreshJobStatus();
  } catch (error) { showToast(error.message); }
}

async function switchPdfVariant() {
  if (state.editingTextId && !(await commitTextAnnotation(state.editingTextId))) { $('pdfVariant').value = state.pdfVariant; return; }
  await state.annotationQueue;
  if (!state.selectedPaper || state.agentBusy) { $('pdfVariant').value = state.pdfVariant; return; }
  const id = state.selectedPaper.id;
  const loadId = ++state.documentLoadId;
  $('pdfVariant').disabled = true;
  const variant = $('pdfVariant').value;
  const page = state.page;
  const previousVariant = state.pdfVariant;
  const previousPdf = state.pdf;
  try {
    // The same viewer retains the requested page when the translated PDF has fewer pages.
    const next = await pdfjsLib.getDocument(`${state.selectedPaper.pdfUrl}?variant=${variant}`).promise;
    if (state.selectedPaper?.id !== id || loadId !== state.documentLoadId) { await next.destroy(); return; }
    state.pdf = next;
    state.pdfVariant = variant;
    state.editingTextId = null; updateAnnotationControls();
    // Search indexes are tied to a PDF document; scan the new language variant again.
    resetSearchResults();
    $('pageCount').textContent = next.numPages;
    await renderDocument();
    if (loadId !== state.documentLoadId) return;
    scrollToPage(page);
    if (!$('pdfSearchBar').hidden) runPdfSearch();
    await previousPdf?.destroy();
    state.selectedText = '';
    updateContextChips();
  } catch (error) {
    if (loadId !== state.documentLoadId) return;
    state.pdf = previousPdf;
    state.pdfVariant = previousVariant;
    $('pdfVariant').value = previousVariant;
    showToast(`PDF 切換失敗：${error.message}`);
  } finally {
    if (loadId === state.documentLoadId) $('pdfVariant').disabled = false;
  }
}

async function refreshModels() {
  $('modelStatus').textContent = '讀取中…';
  try {
    const result = await request('/api/agent/models');
    $('agentModels').replaceChildren(...result.models.map((model) => Object.assign(document.createElement('option'), { value: model.id, label: model.name || model.id })));
    state.models = result.models;
    $('modelStatus').textContent = `${result.models.length} 個可用模型`;
    updateEffortOptions();
  } catch (error) { $('modelStatus').textContent = `模型列表讀取失敗：${error.message}`; }
}

function updateProviderControls() {
  // Claude uses subscription aliases and native effort defaults, independent of the Codex catalog.
  const provider = $('agentProvider').value;
  $('agentModelField').hidden = provider === 'claude';
  $('claudeModelField').hidden = provider !== 'claude';
  $('claudeEffortField').hidden = provider !== 'claude';
  $('agentThinkingField').hidden = provider === 'claude';
  $('refreshModels').hidden = provider !== 'codex';
  $('modelStatus').hidden = provider !== 'codex';
  $('agentModel').setAttribute('list', provider === 'codex' ? 'agentModels' : '');
  $('translationClaudeModelField').hidden = $('translationProvider').value !== 'claude';
  updateEffortOptions();
}

function updateEffortOptions() {
  if ($('agentProvider').value === 'claude') return;
  const model = state.models?.find((item) => item.id === $('agentModel').value || (!$('agentModel').value && item.isDefault));
  const efforts = $('agentProvider').value === 'pi' ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    : model?.supportedReasoningEfforts?.map((effort) => typeof effort === 'string' ? effort : effort.reasoningEffort) || ['low', 'medium', 'high'];
  const value = $('agentThinking').value;
  $('agentThinking').replaceChildren(...efforts.map((effort) => Object.assign(document.createElement('option'), { value: effort, textContent: effort })));
  $('agentThinking').value = efforts.includes(value) ? value : (model?.defaultReasoningEffort || efforts[0]);
}

async function loadAgentStatus() {
  try {
    const { pi } = await request('/api/agent/status');
    $('piStatus').textContent = pi.loggedIn ? 'Pi 已配置登入憑據。' : 'Pi 未登入任何 provider；可改用現有訂閱登入的 Codex 或 Claude。';
  } catch (error) { $('piStatus').textContent = `Pi 狀態讀取失敗：${error.message}`; }
}

// A single awaited polling loop avoids overlapping background requests.
async function pollJobs() {
  try { await loadLibrary(); await refreshJobStatus(); }
  catch (error) { showToast(`背景狀態讀取失敗：${error.message}`); }
  finally { window.setTimeout(pollJobs, 4000); }
}

$('retryParse').addEventListener('click', retryParse);
$('translatePdf').addEventListener('click', translateWholePdf);
$('pdfVariant').addEventListener('change', switchPdfVariant);
$('refreshModels').addEventListener('click', refreshModels);
$('agentModel').addEventListener('change', updateEffortOptions);
$('agentProvider').addEventListener('change', () => {
  updateProviderControls();
  if ($('agentProvider').value === 'codex' && !state.models?.length) refreshModels();
});
$('translationProvider').addEventListener('change', updateProviderControls);
$('newConversation').addEventListener('click', async () => {
  if (state.agentBusy) return showToast('請等待目前回答完成');
  state.followUpContext = '';
  // Clears the saved history (and Claude session) for this paper only.
  if (state.selectedPaper) {
    try { await request(`/api/papers/${state.selectedPaper.id}/chat`, { method: 'DELETE' }); }
    catch (error) { return showToast(error.message); }
  }
  state.chatTurns = 0;
  $('chatMessages').replaceChildren();
  updateContextChips();
  updateMemoryNote();
  updateLatestButton();
  showToast('已開始新對話，先前的記憶已清除');
});

$('uploadButton').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', importLocalFile);
$('arxivForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = $('arxivInput').value.trim();
  if (!url || state.importBusy) return;
  state.importBusy = true;
  try {
    const options = await confirmImport({ fileName: url, detect: () => request('/api/papers/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }),
    }) });
    if (!options) return;
    const result = await request('/api/papers/arxiv', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, folderId: state.importFolderId || 'inbox', ...options }),
    });
    $('arxivInput').value = '';
    await loadLibrary();
    await selectPaper(result);
  } catch (error) { showToast(error.message); }
  finally { state.importBusy = false; }
});
$('folderButton').addEventListener('click', async () => {
  const name = window.prompt('資料夾名稱');
  if (!name?.trim()) return;
  try {
    await request('/api/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    await loadLibrary();
  } catch (error) { showToast(error.message); }
});
$('paperMenu').addEventListener('click', async (event) => {
  const paper = state.papers.find((item) => item.id === state.contextPaperId);
  hideMenus();
  if (!paper) return;
  if (event.target.dataset.action?.startsWith('mark-')) {
    if (state.agentBusy) return showToast('請等待目前回答完成');
    try {
      const sourceKind = event.target.dataset.action === 'mark-translated' ? 'translated' : 'original';
      const updated = await request(`/api/papers/${paper.id}/source`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceKind }),
      });
      await loadLibrary();
      if (state.selectedPaper?.id === paper.id) await selectPaper(updated);
      showToast(sourceKind === 'translated' ? '已標記為已翻譯版' : '已標記為英文原文');
    } catch (error) { showToast(error.message); }
    return;
  }
  if (event.target.dataset.action === 'reindex') {
    showToast(`正在為“${paper.title}”重建全文索引…`);
    try {
      await request(`/api/papers/${paper.id}/reindex`, { method: 'POST' });
      showToast('已在背景重新解析，可繼續閱讀');
      await refreshJobStatus();
    } catch (error) { showToast(error.message); }
    return;
  }
  if (event.target.dataset.action !== 'delete') return;
  if (!window.confirm(`刪除論文“${paper.title}”？`)) return;
  try {
    await request(`/api/papers/${paper.id}`, { method: 'DELETE' });
    await loadLibrary();
  } catch (error) { showToast(error.message); }
});
$('folderMenu').addEventListener('click', async (event) => {
  const action = event.target.dataset.action;
  const folder = state.folders.find((item) => item.id === state.contextFolderId);
  hideMenus();
  if (!folder || !action) return;
  try {
    if (action === 'rename') {
      const name = window.prompt('新的資料夾名稱', folder.name);
      if (!name?.trim()) return;
      await request(`/api/folders/${folder.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    }
    if (action === 'new-child') {
      const name = window.prompt('子資料夾名稱');
      if (!name?.trim()) return;
      await request('/api/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, parentId: folder.id }) });
    }
    if (action === 'import') {
      state.importFolderId = folder.id;
      $('fileInput').click();
      return;
    }
    if (action === 'delete') {
      if (!window.confirm(`刪除“${folder.name}”及其中的論文和子資料夾？`)) return;
      await request(`/api/folders/${folder.id}`, { method: 'DELETE' });
    }
    await loadLibrary();
  } catch (error) { showToast(error.message); }
});
$('settingsButton').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', () => { $('settingsView').hidden = true; $('appShell').hidden = false; });
$('settingsForm').addEventListener('submit', saveSettings);
document.addEventListener('click', (event) => {
  if (!$('folderMenu').contains(event.target) && !$('paperMenu').contains(event.target)) hideMenus();
});
document.addEventListener('selectionchange', trackPdfSelection);
$('cropToggle').addEventListener('click', () => setCropMode(!state.cropMode));
$('previousPage').addEventListener('click', () => { if (state.pdf) scrollToPage(state.page - 1); });
$('nextPage').addEventListener('click', () => { if (state.pdf) scrollToPage(state.page + 1); });
$('pageInput').addEventListener('change', (event) => { if (state.pdf) scrollToPage(Number(event.target.value)); });
$('readerStage').addEventListener('scroll', () => { if (state.pdf) updateCurrentPageFromScroll(); });
$('zoomOut').addEventListener('click', () => changeZoom(-.1));
$('zoomIn').addEventListener('click', () => changeZoom(.1));
$('translateSelection').addEventListener('click', () => translateSelection());
$('chatInput').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
  if (event.ctrlKey) {
    event.preventDefault();
    const input = event.target;
    input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
    return;
  }
  if (event.shiftKey || event.altKey || event.metaKey) return;
  event.preventDefault();
  $('chatForm').requestSubmit();
});
$('chatForm').addEventListener('submit', async (event) => { event.preventDefault(); const input = $('chatInput'); const question = input.value; input.value = ''; await sendQuestion(question); });
for (const button of document.querySelectorAll('.quick-actions button[data-task]')) {
  button.addEventListener('click', () => sendQuestion(button.dataset.prompt, button.dataset.task));
}
$('imageInput').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const paperId = state.selectedPaper?.id; const loadId = state.documentLoadId;
  const attachmentGeneration = ++state.attachmentGeneration;
  const dataUrl = await readAsDataUrl(file);
  if (paperId !== state.selectedPaper?.id || loadId !== state.documentLoadId) return;
  // Uploaded images are explicit items, never an invisible side channel to the next question.
  setAttachment({ kind: 'crop', label: file.name, thumb: dataUrl, imageData: dataUrl, meta: '上傳的圖片' }, false, attachmentGeneration);
  event.target.value = '';
});
setupCropSelection();
updateContextChips();
// First-visit guidance is independent of parsing, model availability and library contents.
$('cancelImport').addEventListener('click', () => $('importDialog').close('cancel'));
initializeTour();
clearReader();
initializeReading();

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Figure list, attachment card, high-resolution crop and model badge.
// ---------------------------------------------------------------------------

const KIND_NAMES = { figure: '圖', table: '表', algorithm: '演算法', equation: '公式' };
// One-click questions per attachment kind: [button label, task template, question text].
const ATTACHMENT_ACTIONS = {
  figure: [['解釋這張圖', 'figure', '請解釋{label}'], ['用例子說明', 'example', '請用例子說明{label}的運作']],
  table: [['這張表的重點', 'table', '請解讀{label}的重點'], ['用例子說明', 'example', '請用例子說明{label}的數字代表什麼']],
  algorithm: [['逐步解釋演算法', 'algorithm', '請解釋{label}的演算法'], ['用例子說明', 'example', '請用數值例子說明{label}']],
  equation: [['解釋公式與符號', 'equation', '請解釋{label}的每個符號與意義'], ['用例子說明', 'example', '請代入數字說明{label}']],
  crop: [['解釋這張圖', 'figure', '請解釋框選的內容'], ['逐步解釋演算法', 'algorithm', '請說明框選的演算法'], ['解釋公式與符號', 'equation', '請解釋框選的公式與符號'], ['這張表的重點', 'table', '請解讀框選的表格重點']],
};

state.elements = [];
state.elementsFor = null;
state.elementFilter = 'all';

function parsedVariant(paper = state.selectedPaper) {
  // MinerU ran on the stored upload: original.pdf, or the translated file when that was uploaded.
  return paper?.sourceKind === 'translated' ? (paper.translatedVariant || 'bilingual') : 'original';
}

function showAssistantTab(tab) {
  $('tabChat').setAttribute('aria-selected', String(tab === 'chat'));
  $('tabElements').setAttribute('aria-selected', String(tab === 'elements'));
  $('tabNotes').setAttribute('aria-selected', String(tab === 'notes'));
  $('notesPanel').hidden = tab !== 'notes';
  $('elementsPanel').hidden = tab !== 'elements';
  $('chatMessages').hidden = tab !== 'chat';
  $('chatViewport').hidden = tab !== 'chat';
  (pipDocument?.querySelector('.quick-actions') || document.querySelector('.quick-actions')).hidden = tab !== 'chat';
  if (tab === 'elements' && state.selectedPaper && state.elementsFor !== state.selectedPaper.id) loadElements();
  updateLatestButton();
}

async function loadElements() {
  const id = state.selectedPaper?.id;
  if (!id) return;
  try {
    const { elements, hotspots = [] } = await request(`/api/papers/${id}/elements`);
    if (state.selectedPaper?.id !== id) return;
    state.elements = elements;
    // Click targets on both halves of bilingual pages; translated copies point at their English twin.
    state.hotspots = hotspots;
    state.elementsFor = elements.length ? id : null;
    renderElements();
  } catch (error) { showToast(`圖表清單讀取失敗：${error.message}`); }
}

function elementImageUrl(element) {
  return element.image ? `/api/papers/${state.selectedPaper.id}/element-image?path=${encodeURIComponent(element.image)}` : '';
}

function renderElements() {
  const list = $('elementList');
  const items = state.elements.filter((item) => state.elementFilter === 'all' || item.kind === state.elementFilter);
  for (const button of $('elementFilter').children) {
    const kind = button.dataset.kind;
    const count = kind === 'all' ? state.elements.length : state.elements.filter((item) => item.kind === kind).length;
    button.textContent = `${kind === 'all' ? '全部' : KIND_NAMES[kind]} ${count}`;
    button.classList.toggle('active', kind === state.elementFilter);
  }
  if (!state.elements.length) {
    const parse = state.jobStatus?.parse.status;
    list.innerHTML = `<p class="muted">${parse === 'running' ? '論文解析中，完成後會列出圖、表、演算法與公式。' : '尚未有解析結果。完成解析後，這裡會列出所有圖、表、演算法與公式。'}</p>`;
    return;
  }
  list.replaceChildren(...items.map((element) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'element-item';
    const thumb = element.image ? Object.assign(document.createElement('img'), { className: 'element-thumb', loading: 'lazy', alt: element.label, src: elementImageUrl(element) })
      : Object.assign(document.createElement('div'), { className: 'element-thumb text-thumb', textContent: element.text.split('\n')[0].slice(0, 60) });
    const body = document.createElement('div');
    body.innerHTML = `<strong><span class="element-kind">${KIND_NAMES[element.kind]}</span>${escapeHtml(element.label)}</strong><small>第 ${element.page} 頁${element.caption ? ` · ${escapeHtml(element.caption)}` : ''}</small>`;
    button.append(thumb, body);
    button.dataset.elementId = element.id;
    button.setAttribute('aria-pressed', String(state.attachments.some((item) => item.elementId === element.id)));
    button.addEventListener('click', (event) => focusElement(element, event.ctrlKey || event.metaKey));
    return button;
  }));
}

async function focusElement(element, additive = false) {
  if (!state.pdf) return showToast('PDF 尚未載入完成');
  const paperId = state.selectedPaper?.id;
  const attachmentGeneration = ++state.attachmentGeneration;
  // Page numbers and boxes refer to the parsed file, so show that version before jumping.
  const variant = parsedVariant();
  if (state.pdfVariant !== variant && [...$('pdfVariant').options].some((option) => option.value === variant)) {
    $('pdfVariant').value = variant;
    await switchPdfVariant();
  }
  if (state.selectedPaper?.id !== paperId || state.attachmentGeneration !== attachmentGeneration) return;
  scrollToPage(element.page);
  highlightBox(element.page, element.bbox);
  setAttachment({ kind: element.kind, elementId: element.id, page: element.page, label: element.label, meta: `第 ${element.page} 頁 · 已附上論文原文`, thumb: elementImageUrl(element) }, additive, attachmentGeneration);
  // Keep the list open during Ctrl selection so several figures can be picked in sequence.
  if (!additive) showAssistantTab('chat');
}

function highlightBox(pageNumber, bbox) {
  const page = $('pdfPages').children[pageNumber - 1];
  if (!page || !bbox) return;
  const [x0, y0, x1, y1] = bbox;
  const box = Object.assign(document.createElement('div'), { className: 'element-highlight' });
  Object.assign(box.style, { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` });
  page.append(box);
  window.setTimeout(() => box.remove(), 2600);
}

function setAttachment(attachment, additive = false, generation) {
  if (generation !== undefined && generation !== state.attachmentGeneration) return false;
  if (generation === undefined) ++state.attachmentGeneration;
  attachment.id ||= crypto.randomUUID();
  attachment.variant ||= state.pdfVariant;
  const result = updateAttachments(state.attachments, attachment, additive);
  state.attachments = result.attachments;
  if (result.error) showToast(result.error);
  renderAttachments();
  return state.attachments.includes(attachment);
}

function renderAttachments() {
  // Use $ for every assistant control: this DOM may belong to the detached assistant window.
  const items = state.attachments;
  $('attachmentCard').hidden = !items.length;
  $('attachmentTitle').textContent = `這次提問會附上 ${items.length} 項`;
  $('attachmentList').replaceChildren(...items.map((item) => {
    const card = Object.assign(document.createElement('div'), { className: 'attachment-item' });
    card.dataset.attachmentKey = item.elementId || item.id;
    if (item.thumb) card.append(Object.assign(document.createElement('img'), { src: item.thumb, alt: item.label }));
    const body = Object.assign(document.createElement('div'), { className: 'attachment-body' });
    const title = Object.assign(document.createElement('strong'), { textContent: item.label });
    title.title = item.text || item.label;
    body.append(title, Object.assign(document.createElement('small'), { className: 'muted', textContent: item.meta || '' }));
    const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'attachment-remove', textContent: '×', title: `移除 ${item.label}` });
    remove.setAttribute('aria-label', `移除 ${item.label}`);
    remove.addEventListener('click', () => {
      ++state.attachmentGeneration;
      state.attachments = state.attachments.filter((entry) => entry !== item);
      state.selectedText = state.attachments.findLast((entry) => entry.text)?.text || '';
      window.getSelection()?.removeAllRanges();
      renderAttachments();
    });
    card.append(body, remove);
    return card;
  }));
  $('attachmentHint').textContent = items.filter((item) => item.imageData || (item.elementId && item.thumb)).length > 4
    ? '最多附上 4 張圖片，其餘項目附上原文。Ctrl／⌘ 可多選，最多 6 項。'
    : 'Ctrl／⌘ 可加入多選，再點同一圖表可移除；一般選取會取代。最多 6 項。';
  const attachment = items[0];
  const actions = items.length > 1 ? [
    ['比較這些', 'compare', '請逐項說明這些附件，再比較異同、彼此關聯，以及它們在論文中的角色。'],
    ['分別解釋', 'question', '請依附件編號逐項解釋每一項內容、重點及其在論文中的意義。'],
    ...(items.every((item) => item.text && !item.elementId && !item.imageData) ? [['一起翻譯', '__translate_all']] : []),
  ] : attachment ? ATTACHMENT_ACTIONS[attachment.kind] || [] : [];
  // Example level is an explicit request option; every explanation shares the persisted depth.
  const expandedActions = actions.flatMap(([text, task, question]) => task === 'example'
    ? [['簡單舉例', task, question, 'simple'], ['完整舉例', task, question, 'full']]
    : [[text, task, question]]);
  const buttons = expandedActions.map(([text, task, question, exampleLevel]) => {
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: text });
    button.addEventListener('click', () => {
      if (task === '__translate_all') return translateAttachments();
      if (task === '__translate') return translateSelection(attachment.text, attachment);
      const label = attachment.kind === 'crop' ? '' : ` ${attachment.label} `;
      sendQuestion(question.replace('{label}', label).replace('{text}', attachment.text || '').replace(/\s+/g, ' ').trim(), task, { exampleLevel });
    });
    return button;
  });
  const explanationCount = expandedActions.filter(([, task]) => !task.startsWith('__translate') && task !== 'example').length;
  if (explanationCount) buttons.splice(1, 0, detailSegment());
  $('attachmentActions').replaceChildren(...buttons);
  updateAnswerDetail();
  const labels = items.map((item) => item.label).join('、');
  $('chatInput').placeholder = items.length ? `詢問 ${labels.slice(0, 90)}…（已附加，Enter 傳送）` : '詢問論文內容…（Enter 傳送，Ctrl+Enter 換行）';
  $('chatInput').setAttribute('aria-describedby', items.length ? 'attachmentTitle attachmentHint' : '');
  for (const button of $('elementList').querySelectorAll('[data-element-id]')) {
    button.setAttribute('aria-pressed', String(items.some((item) => item.elementId === button.dataset.elementId)));
  }
  updateContextChips();
}

function clearAttachment() {
  ++state.attachmentGeneration;
  state.attachments = [];
  state.selectedText = '';
  window.getSelection()?.removeAllRanges();
  $('imageStatus').textContent = '';
  renderAttachments();
}

async function translateAttachments() {
  // A single translation request preserves visible item order and each passage's page reference.
  const snapshot = [...state.attachments];
  const text = snapshot.map((item, i) => `附件 ${i + 1}（第 ${item.page} 頁）\n${item.text}`).join('\n\n');
  if (snapshot.every((item) => item.counterpart)) {
    $('translationPanel').hidden = false;
    $('translationStatus').textContent = '雙語對照';
    $('translationResult').textContent = snapshot.map((item, i) => `附件 ${i + 1}（第 ${item.page} 頁）\n${item.counterpart}`).join('\n\n');
    return;
  }
  await translateSelection(text, null);
}

// Re-render the cropped region from the PDF at high resolution so small text stays legible.
async function captureCrop(pageNumber, rect) {
  const page = await state.pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const regionPoints = Math.max(1, rect.w * base.width);
  // At least 2.5x PDF units, aiming for ~1800px wide crops; the longest side is capped at 2600px.
  const longest = Math.max(rect.w * base.width, rect.h * base.height);
  const scale = Math.min(6, Math.max(2.5, 1800 / regionPoints), 2600 / longest);
  // Render only the selected region (viewport offset) instead of the whole page at high zoom.
  const viewport = page.getViewport({ scale, offsetX: -rect.x * base.width * scale, offsetY: -rect.y * base.height * scale });
  const crop = document.createElement('canvas');
  crop.width = Math.max(1, Math.round(rect.w * base.width * scale)); crop.height = Math.max(1, Math.round(rect.h * base.height * scale));
  await page.render({ canvasContext: crop.getContext('2d', { alpha: false }), viewport }).promise;
  // Text inside the box (PDF text layer) gives the model exact characters for formulas and code.
  const content = await page.getTextContent();
  const text = content.items.filter((item) => {
    // pdf.js 5 applies the transform in place and returns nothing.
    const point = [item.transform[4], item.transform[5]];
    pdfjsLib.Util.applyTransform(point, base.transform);
    const [x, y] = point;
    const nx = x / base.width; const ny = y / base.height;
    return nx >= rect.x - .005 && nx <= rect.x + rect.w && ny >= rect.y && ny <= rect.y + rect.h + .01;
  }).map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim();
  return { dataUrl: crop.toDataURL('image/png'), width: crop.width, height: crop.height, text };
}


// Translation-generated bilingual PDF of a parsed original: each page is side by side, the left half
// being the original page (parsed by MinerU) and the right half its translation in the same layout.
function isGeneratedDual() {
  if (state.pdfVariant !== 'bilingual' || parsedVariant() === 'bilingual') return false;
  const first = $('pdfPages').children[0];
  return Boolean(first && first.offsetWidth > first.offsetHeight);
}

// Click/crop targets for the current PDF version (parsed layout, or both halves of a generated dual).
function currentSpots() {
  if (state.pdfVariant === parsedVariant()) {
    return state.hotspots?.length ? state.hotspots : state.elements.map((element) => ({ ...element, targetId: element.id, mirrored: false }));
  }
  if (!isGeneratedDual()) return [];
  return state.elements.filter((element) => element.bbox).flatMap((element) => {
    const [x0, y0, x1, y1] = element.bbox;
    return [
      { page: element.page, bbox: [x0 / 2, y0, x1 / 2, y1], targetId: element.id, mirrored: false },
      { page: element.page, bbox: [x0 / 2 + 0.5, y0, x1 / 2 + 0.5, y1], targetId: element.id, mirrored: true },
    ];
  });
}

// Find the parsed element the crop mostly covers (e.g. an algorithm box) to attach its exact source.
function matchElement(pageNumber, rect) {
  const byId = new Map(state.elements.map((element) => [element.id, element]));
  const spots = currentSpots();
  let best = null;
  for (const spot of spots) {
    const element = byId.get(spot.targetId);
    if (!element || spot.page !== pageNumber || !spot.bbox) continue;
    const [x0, y0, x1, y1] = spot.bbox;
    const overlap = Math.max(0, Math.min(x1, rect.x + rect.w) - Math.max(x0, rect.x)) * Math.max(0, Math.min(y1, rect.y + rect.h) - Math.max(y0, rect.y));
    const score = Math.min(overlap / ((x1 - x0) * (y1 - y0) || 1), overlap / (rect.w * rect.h || 1));
    if (score > .55 && (!best || score > best.score)) best = { element, score };
  }
  return best?.element || null;
}

async function handleCrop(pageNumber, rect, additive = false) {
  const paperId = state.selectedPaper?.id; const loadId = state.documentLoadId;
  const attachmentGeneration = ++state.attachmentGeneration;
  state.cropStatusGeneration = attachmentGeneration;
  try {
    $('imageStatus').textContent = '擷取高解析截圖中…';
    if (state.elementsFor !== state.selectedPaper?.id) await loadElements();
    const shot = await captureCrop(pageNumber, rect);
    if (state.selectedPaper?.id !== paperId || state.documentLoadId !== loadId || state.attachmentGeneration !== attachmentGeneration) return;
    const element = matchElement(pageNumber, rect);
    if (shot.text) state.selectedText = shot.text;
    setAttachment({
      kind: element ? element.kind : 'crop', elementId: element?.id, page: pageNumber, label: element ? element.label : `第 ${pageNumber} 頁框選`, thumb: shot.dataUrl, imageData: shot.dataUrl, text: shot.text,
      meta: `第 ${pageNumber} 頁 · ${shot.width}×${shot.height}${element ? ' · 已對應論文原文' : shot.text ? ' · 含框內文字' : ''}`,
    }, additive, attachmentGeneration);
    $('imageStatus').textContent = '';
  } catch (error) {
    if (state.attachmentGeneration === attachmentGeneration) showToast(`截圖失敗：${error.message}`);
  } finally {
    // A superseded crop may clear its own status, while a newer crop keeps its progress message.
    if (state.cropStatusGeneration === attachmentGeneration) $('imageStatus').textContent = '';
  }
}

// ---- Model badge -----------------------------------------------------------

async function loadModelBadge() {
  try {
    const settings = await request('/api/settings');
    state.agentSettings = settings.agent;
    if (settings.agent.provider === 'codex' && !state.models?.length) {
      try { state.models = (await request('/api/agent/models')).models; } catch { state.models = []; }
    }
    renderModelBadge();
  } catch (error) { $('modelBadge').textContent = `模型設定讀取失敗：${error.message}`; }
}

function codexDefaultModel() {
  return state.models?.find((model) => model.isDefault)?.id || 'CLI 預設';
}

function renderModelBadge() {
  const agent = state.agentSettings;
  if (!agent) return;
  const text = agent.provider === 'claude' ? `Claude · ${agent.claudeModel} · ${agent.claudeEffort || '預設強度'}`
    : agent.provider === 'pi' ? `Pi · ${agent.model || '預設模型'} · ${agent.thinking}`
      : `Codex · ${agent.model || codexDefaultModel()} · ${agent.thinking}`;
  $('modelBadge').textContent = `目前模型：${text}`;
}

async function fillModelMenu() {
  const agent = state.agentSettings;
  $('quickProvider').value = agent.provider;
  try {
    const { pi } = await request('/api/agent/status');
    $('quickProvider').querySelector('option[value="pi"]').disabled = !pi.loggedIn;
    $('quickModelNote').textContent = pi.loggedIn ? '' : 'Pi 尚未登入，已停用；Codex 與 Claude 使用既有訂閱登入。';
  } catch { /* Pi status is informational only. */ }
  const option = (value, label) => Object.assign(document.createElement('option'), { value, textContent: label });
  if (agent.provider === 'claude') {
    const models = ['sonnet', 'opus', 'haiku'];
    if (!models.includes(agent.claudeModel)) models.push(agent.claudeModel);
    $('quickModel').replaceChildren(...models.map((name) => option(name, name)));
    $('quickModel').value = agent.claudeModel;
    // Claude CLI supports --effort; '' keeps the CLI default.
    $('quickEffort').replaceChildren(option('', '預設'), ...['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => option(effort, effort)));
    $('quickEffort').value = agent.claudeEffort || '';
    $('quickEffortField').hidden = false;
    return;
  }
  if (agent.provider === 'codex' && !state.models?.length) {
    try { state.models = (await request('/api/agent/models')).models; } catch { state.models = []; }
  }
  const models = agent.provider === 'codex' ? state.models || [] : [];
  $('quickModel').replaceChildren(option('', `CLI 預設（${agent.provider === 'codex' ? codexDefaultModel() : '預設'}）`), ...models.map((model) => option(model.id, model.name || model.id)));
  if (agent.model && !models.some((model) => model.id === agent.model)) $('quickModel').append(option(agent.model, agent.model));
  $('quickModel').value = agent.model || '';
  const selected = models.find((model) => model.id === agent.model) || models.find((model) => model.isDefault);
  const efforts = agent.provider === 'pi' ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
    : selected?.supportedReasoningEfforts?.map((effort) => (typeof effort === 'string' ? effort : effort.reasoningEffort)) || ['low', 'medium', 'high'];
  $('quickEffort').replaceChildren(...efforts.map((effort) => option(effort, effort)));
  $('quickEffort').value = efforts.includes(agent.thinking) ? agent.thinking : efforts[0];
  $('quickEffortField').hidden = false;
}

async function saveQuickAgent(patch) {
  const previous = state.agentSettings.provider;
  try {
    const saved = await request('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: { ...state.agentSettings, ...patch } }) });
    state.agentSettings = saved.agent || { ...state.agentSettings, ...patch };
    renderModelBadge();
    await fillModelMenu();
    if (state.agentSettings.provider !== previous) {
      // The saved transcript carries over, so switching providers keeps the conversation memory.
      showToast(`已切換為 ${({ codex: 'Codex', claude: 'Claude', pi: 'Pi' })[state.agentSettings.provider]}，對話記憶會延續，下一則提問生效`);
    } else showToast('模型設定已更新，下一則提問生效');
  } catch (error) { showToast(error.message); }
}

$('modelBadge').addEventListener('click', async (event) => {
  event.stopPropagation();
  const open = $('modelMenu').hidden;
  if (open && state.agentSettings) await fillModelMenu();
  $('modelMenu').hidden = !open;
  $('modelBadge').setAttribute('aria-expanded', String(open));
});
$('modelMenu').addEventListener('click', (event) => event.stopPropagation());
document.addEventListener('click', () => { $('modelMenu').hidden = true; $('modelBadge').setAttribute('aria-expanded', 'false'); });
$('quickProvider').addEventListener('change', () => saveQuickAgent({ provider: $('quickProvider').value }));
$('quickModel').addEventListener('change', () => saveQuickAgent(state.agentSettings.provider === 'claude' ? { claudeModel: $('quickModel').value } : { model: $('quickModel').value }));
$('quickEffort').addEventListener('change', () => saveQuickAgent(state.agentSettings.provider === 'claude' ? { claudeEffort: $('quickEffort').value } : { thinking: $('quickEffort').value }));

$('tabChat').addEventListener('click', () => showAssistantTab('chat'));
$('tabElements').addEventListener('click', () => showAssistantTab('elements'));
$('elementFilter').addEventListener('click', (event) => {
  const kind = event.target.closest('button')?.dataset.kind;
  if (!kind) return;
  state.elementFilter = kind;
  renderElements();
});
$('attachmentRemove').addEventListener('click', clearAttachment);
document.querySelector('[data-open-elements]').addEventListener('click', () => showAssistantTab('elements'));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.cropMode) setCropMode(false); });
loadModelBadge();

// ---------------------------------------------------------------------------
// Saved conversation, click-to-select on the PDF, and text-selection actions.
// ---------------------------------------------------------------------------

// Text attachments: a highlighted passage or a short term. '__translate' runs the selection translator.
ATTACHMENT_ACTIONS.passage = [['解釋這段', 'passage', '請解釋這段文字'], ['翻譯', '__translate'], ['用例子說明', 'example', '請用例子說明這段內容']];
ATTACHMENT_ACTIONS.term = [['解釋這個名詞', 'term', '請解釋「{text}」'], ['翻譯', '__translate'], ['用例子說明', 'example', '請用例子說明「{text}」']];

async function loadChat(paperId, loadId = state.documentLoadId) {
  try {
    const { turns } = await request(`/api/papers/${paperId}/chat`);
    if (state.selectedPaper?.id !== paperId || loadId !== state.documentLoadId) return;
    $('chatMessages').replaceChildren();
    for (const turn of turns) {
      addMessage('user', turn.label ? `［${turn.label}］${turn.question}` : turn.question);
      const { content, followUpButton } = addMessage('assistant', '');
      content.dataset.answer = turn.answer;
      content.innerHTML = renderMarkdown(turn.answer);
      followUpButton.hidden = false;
    }
    state.chatTurns = turns.length;
    updateMemoryNote();
    // History still opens at the end after Markdown and the memory label finish changing layout.
    $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
    updateLatestButton();
  } catch (error) { if (loadId === state.documentLoadId) showToast(`對話紀錄讀取失敗：${error.message}`); }
  finally { if (loadId === state.documentLoadId) state.chatLoading = false; }
}

function updateMemoryNote() {
  const turns = state.chatTurns || 0;
  $('memoryNote').textContent = !state.selectedPaper ? '' : turns
    ? `對話記憶：本篇已保存 ${turns} 輪，追問會延續上下文；「新對話」可清除。`
    : '對話記憶：會保存在本機，重新整理或重開後仍可延續。';
}

// Smallest parsed element containing a normalized point on the given page.
function elementAt(pageNumber, x, y) {
  if (!state.elements.length) return null;
  const byId = new Map(state.elements.map((element) => [element.id, element]));
  const spots = currentSpots();
  let best = null;
  for (const spot of spots) {
    if (spot.page !== pageNumber || !spot.bbox) continue;
    const [x0, y0, x1, y1] = spot.bbox;
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    const size = (x1 - x0) * (y1 - y0);
    const element = byId.get(spot.targetId);
    if (element && (!best || size < best.size)) best = { element, size, spot };
  }
  // The returned element is the English original; `spot` is the box actually under the cursor.
  return best ? { ...best.element, spotBbox: best.spot.bbox, mirrored: best.spot.mirrored } : null;
}

function pointerOnPage(event) {
  const page = event.target.closest?.('.pdf-page');
  if (!page) return null;
  const rect = page.getBoundingClientRect();
  return { page, pageNumber: Number(page.dataset.page), x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
}

function setupElementHover() {
  const pages = $('pdfPages');
  const outline = Object.assign(document.createElement('div'), { className: 'element-hover' });
  const tag = Object.assign(document.createElement('span'), { className: 'element-hover-tag' });
  outline.append(tag);
  let current = null;
  const hide = () => { outline.remove(); current = null; pages.classList.remove('element-pointer'); };
  pages.addEventListener('mousemove', (event) => {
    if (state.cropMode || event.buttons) return hide();
    const point = pointerOnPage(event);
    const element = point && elementAt(point.pageNumber, point.x, point.y);
    if (!element) return hide();
    if (current?.id === element.id && current?.mirrored === element.mirrored) return;
    current = element;
    const [x0, y0, x1, y1] = element.spotBbox || element.bbox;
    Object.assign(outline.style, { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` });
    tag.textContent = `點擊選取 ${KIND_NAMES[element.kind]} · ${element.label}${element.mirrored ? '（中文對照側）' : ''}`;
    point.page.append(outline);
    pages.classList.add('element-pointer');
  });
  pages.addEventListener('mouseleave', hide);
  // A plain click (not a drag-selection) on a figure/table/algorithm/equation attaches it.
  pages.addEventListener('click', (event) => {
    if (state.cropMode || window.getSelection()?.toString().trim()) return;
    const point = pointerOnPage(event);
    const element = point && elementAt(point.pageNumber, point.x, point.y);
    if (!element) return;
    setAttachment({ kind: element.kind, elementId: element.id, page: element.page, label: element.label, meta: `第 ${element.page} 頁${element.mirrored ? '（點選中文對照側）' : ''} · 已附上英文原文`, thumb: elementImageUrl(element) }, event.ctrlKey || event.metaKey);
    showAssistantTab('chat');
    flashAttachmentCard();
  });
}

function flashAttachmentCard() {
  const card = $('attachmentCard');
  card.classList.remove('flash');
  void card.offsetWidth;
  card.classList.add('flash');
}

// After a mouse/keyboard selection in the PDF, show it as an attachment with explain/translate actions.
function captureTextSelection(additive = false, { paragraph = false } = {}) {
  if (state.cropMode) return;
  const selection = window.getSelection();
  const text = selection?.toString().replace(/\s+/g, ' ').trim();
  if (!text || !selection.rangeCount || !$('pdfPages').contains(selection.anchorNode)) return;
  const page = (selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement)?.closest('.pdf-page');
  const pageNumber = Number(page?.dataset.page) || state.page;
  // Short selections (a few words) are treated as a term; longer ones as a passage.
  // A whole-paragraph selection (triple-click / 整段) is always a passage, even if short.
  const isTerm = !paragraph && text.length <= 40 && text.split(/\s+/).length <= 5;
  state.selectedText = text;
  const attachment = {
    kind: isTerm ? 'term' : 'passage', text, label: isTerm ? text : `「${text.slice(0, 28)}${text.length > 28 ? '…' : ''}」`,
    page: pageNumber, meta: `第 ${pageNumber} 頁 · 選取${isTerm ? '名詞' : `${paragraph ? '整段' : '段落'}（${text.length} 字）`}`, thumb: null,
  };
  const attached = setAttachment(attachment, additive);
  showAssistantTab('chat');
  flashAttachmentCard();
  if (attached && page && state.pdfVariant === parsedVariant()) loadCounterpart(page, pageNumber, selection.getRangeAt(0), attachment);
  else if (attached && page && isGeneratedDual()) loadGeneratedDualCounterpart(page, pageNumber, selection.getRangeAt(0), attachment);
}

// Bilingual side-by-side pages: find the same paragraph on the other half via MinerU blocks.
async function loadCounterpart(page, pageNumber, range, attachment) {
  const pageRect = page.getBoundingClientRect();
  const box = range.getBoundingClientRect();
  const rect = { x: (box.left - pageRect.left) / pageRect.width, y: (box.top - pageRect.top) / pageRect.height, w: box.width / pageRect.width, h: box.height / pageRect.height };
  try {
    const { counterpart } = await request(`/api/papers/${state.selectedPaper.id}/counterpart`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page: pageNumber, rect }),
    });
    if (!counterpart || !state.attachments.includes(attachment)) return;
    attachment.counterpart = counterpart.text;
    attachment.counterpartLang = counterpart.otherLang;
    attachment.meta = `${attachment.meta} · 已附上${counterpart.otherLang === 'en' ? '英文原文' : '中文譯文'}對照`;
    renderAttachments();
  } catch { /* Counterpart is an optional aid; single-language papers simply have none. */ }
}

// Generated side-by-side translation: map the selection to the original page, fetch the matching
// parsed paragraphs, and read the other language from the corresponding half of the same page.
async function loadGeneratedDualCounterpart(page, pageNumber, range, attachment) {
  const pageRect = page.getBoundingClientRect();
  const box = range.getBoundingClientRect();
  const x = (box.left - pageRect.left) / pageRect.width; const y = (box.top - pageRect.top) / pageRect.height;
  const w = box.width / pageRect.width; const h = box.height / pageRect.height;
  const rightHalf = x + w / 2 >= 0.5;
  // Original-page coordinates of the selection (each half is one full original page).
  const rect = { x: (rightHalf ? x - 0.5 : x) * 2, y, w: w * 2, h };
  try {
    const { blocks = [] } = await request(`/api/papers/${state.selectedPaper.id}/counterpart`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page: pageNumber, rect, generatedDual: true }),
    });
    if (!blocks.length || !state.attachments.includes(attachment)) return;
    let text;
    if (rightHalf) text = blocks.map((block) => block.text).join('\n\n');
    else {
      // English selected: read the translated paragraphs from the right half at the same boxes.
      const pdfPage = await state.pdf.getPage(pageNumber);
      const base = pdfPage.getViewport({ scale: 1 });
      const items = (await pdfPage.getTextContent()).items;
      text = blocks.map((block) => {
        const [bx0, by0, bx1, by1] = [block.bbox[0] / 2 + 0.5, block.bbox[1], block.bbox[2] / 2 + 0.5, block.bbox[3]];
        return items.filter((item) => {
          const point = [item.transform[4], item.transform[5]];
          pdfjsLib.Util.applyTransform(point, base.transform);
          const nx = point[0] / base.width; const ny = point[1] / base.height;
          return nx >= bx0 - 0.01 && nx <= bx1 + 0.01 && ny >= by0 - 0.005 && ny <= by1 + 0.02;
        }).map((item) => item.str + (item.hasEOL ? '\n' : '')).join('').trim();
      }).filter(Boolean).join('\n\n');
    }
    if (!text || !state.attachments.includes(attachment)) return;
    attachment.counterpart = text.slice(0, 8000);
    attachment.counterpartLang = rightHalf ? 'en' : 'zh';
    attachment.meta = `${attachment.meta} · 已附上${rightHalf ? '英文原文' : '中文譯文'}對照`;
    renderAttachments();
  } catch { /* Counterpart is optional. */ }
}

// Capture modifiers before the asynchronous selection callback or pointer release loses them.
let selectionAdditive = false;
let selectionGesture = 0;
$('pdfPages').addEventListener('mousedown', (event) => { ++selectionGesture; selectionAdditive = event.ctrlKey || event.metaKey; });
$('pdfPages').addEventListener('mouseup', (event) => {
  const additive = selectionAdditive || event.ctrlKey || event.metaKey;
  const gesture = selectionGesture;
  selectionAdditive = false;
  // A plain figure click has no selected text. Its deferred callback must not capture a later drag.
  if (!window.getSelection()?.toString().trim()) return;
  window.setTimeout(() => { if (gesture === selectionGesture) captureTextSelection(additive); }, 0);
});
$('pdfPages').addEventListener('keyup', (event) => { if (event.shiftKey) captureTextSelection(event.ctrlKey || event.metaKey); });

// ---------------------------------------------------------------------------
// Paragraph selection: triple-click text, or press 「¶ 整段」 on the selection toolbar, to select
// whole paragraphs. Boxes come from MinerU's parsed layout; without a parse, nearby lines of the
// same column are grouped by geometry.
// ---------------------------------------------------------------------------

// Leaf text spans of a page's pdf.js text layer, in document (reading) order.
function textSpans(page) {
  return [...page.querySelectorAll('.textLayer span')].filter((span) => !span.querySelector('span') && span.textContent.trim());
}

// MinerU paragraph box (normalized to the displayed page) containing point (x, y), or null.
async function parsedParagraphBox(pageNumber, x, y) {
  if (!state.selectedPaper) return null;
  const dual = isGeneratedDual();
  // Mono Chinese keeps the original layout, so original-page boxes apply to it as well.
  const sameLayout = state.pdfVariant === parsedVariant() || (state.pdfVariant === 'chinese' && parsedVariant() === 'original');
  if (!dual && !sameLayout) return null;
  const offset = dual && x >= 0.5 ? 0.5 : 0;
  const px = dual ? (x - offset) * 2 : x;
  try {
    // The generatedDual form returns raw parsed blocks with their boxes.
    const { blocks = [] } = await request(`/api/papers/${state.selectedPaper.id}/counterpart`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: pageNumber, rect: { x: px, y, w: 0.0005, h: 0.0005 }, generatedDual: true }),
    });
    if (!blocks.length) return null;
    // The smallest containing block is the paragraph (not a surrounding section).
    const [x0, y0, x1, y1] = blocks.map((block) => block.bbox).sort((a, b) => (a[2] - a[0]) * (a[3] - a[1]) - (b[2] - b[0]) * (b[3] - b[1]))[0];
    return dual ? [x0 / 2 + offset, y0, x1 / 2 + offset, y1] : [x0, y0, x1, y1];
  } catch { return null; }
}

// Fallback without a parse: extend from the clicked line while lines stay close and in its column.
function geometricParagraph(spans, index, pageRect) {
  const rectOf = (span) => span.getBoundingClientRect();
  const origin = rectOf(spans[index]);
  const center = pageRect.left + pageRect.width / 2;
  // Lines wider than half the page mean a single-column layout.
  const side = origin.width > pageRect.width * 0.5 ? 0 : (origin.left + origin.width / 2 < center ? -1 : 1);
  const sameColumn = (rect) => side === 0 || (side < 0 ? rect.left + rect.width / 2 < center : rect.left + rect.width / 2 >= center);
  const walk = (step) => {
    let last = index; let lastRect = origin;
    for (let i = index + step; i >= 0 && i < spans.length; i += step) {
      const rect = rectOf(spans[i]);
      if (!sameColumn(rect)) break;
      const lineHeight = Math.max(4, Math.min(rect.height, lastRect.height));
      // Same line, or the next line with no blank-line gap in between.
      const gap = step > 0 ? rect.top - lastRect.bottom : lastRect.top - rect.bottom;
      if (Math.abs(rect.top - lastRect.top) > lineHeight * 0.5 && (gap > lineHeight * 0.75 || gap < -lineHeight * 3)) break;
      last = i; lastRect = rect;
    }
    return last;
  };
  return [walk(-1), walk(1)];
}

// Index range [first, last] of the spans belonging to the paragraph that contains `span`.
async function paragraphSpanRange(page, spans, span) {
  const pageRect = page.getBoundingClientRect();
  const index = spans.indexOf(span);
  if (index < 0) return null;
  const rect = span.getBoundingClientRect();
  const x = (rect.left + rect.width / 2 - pageRect.left) / pageRect.width;
  const y = (rect.top + rect.height / 2 - pageRect.top) / pageRect.height;
  const box = await parsedParagraphBox(Number(page.dataset.page), x, y);
  if (box) {
    const inside = spans.map((item, i) => {
      const r = item.getBoundingClientRect();
      const cx = (r.left + r.width / 2 - pageRect.left) / pageRect.width;
      const cy = (r.top + r.height / 2 - pageRect.top) / pageRect.height;
      return cx >= box[0] - 0.01 && cx <= box[2] + 0.01 && cy >= box[1] - 0.006 && cy <= box[3] + 0.01 ? i : -1;
    }).filter((i) => i >= 0);
    if (inside.includes(index)) return [inside[0], inside.at(-1)];
  }
  return geometricParagraph(spans, index, pageRect);
}

// Select from the paragraph of startSpan to the paragraph of endSpan and attach it as a passage.
async function selectParagraphs(startSpan, endSpan = startSpan, additive = false) {
  const page = startSpan?.closest('.pdf-page');
  if (!page || endSpan.closest('.pdf-page') !== page) return;
  const spans = textSpans(page);
  const first = await paragraphSpanRange(page, spans, startSpan);
  const last = endSpan === startSpan ? first : await paragraphSpanRange(page, spans, endSpan);
  if (!first || !last) return;
  const from = spans[Math.min(first[0], last[0])]; const to = spans[Math.max(first[1], last[1])];
  const range = document.createRange();
  range.setStart(from.firstChild || from, 0);
  range.setEnd(to.firstChild || to, (to.firstChild || to).textContent.length);
  const selection = window.getSelection();
  selection.removeAllRanges(); selection.addRange(range);
  captureTextSelection(additive, { paragraph: true });
  showSelectionToolbar();
}

// Leaf text span at a DOM boundary point (selection anchors are usually text nodes).
function spanAtNode(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  const span = element?.closest?.('.textLayer span');
  return span && !span.querySelector('span') ? span : null;
}

$('pdfPages').addEventListener('click', (event) => {
  if (event.detail !== 3 || state.cropMode) return;
  const span = spanAtNode(event.target);
  if (!span) return;
  // Cancel the pending capture of the browser's own triple-click (single line) selection.
  ++selectionGesture;
  selectParagraphs(span, span, event.ctrlKey || event.metaKey);
});
setupElementHover();

// ---------------------------------------------------------------------------
// Highlighter and notes (Adobe-style): select text → pick a color, click a highlight → note.
// Highlights are stored per paper and per PDF version, and can be exported into the PDF.
// ---------------------------------------------------------------------------

state.annotations = [];
state.pendingSelection = null;
state.openAnnotationId = null;
const COLOR_NAMES = { yellow: '黃', green: '綠', pink: '粉紅', blue: '藍' };

async function loadAnnotations(paperId) {
  try {
    const { annotations, savedAnnotations = {} } = await request(`/api/papers/${paperId}/annotations`);
    if (state.selectedPaper?.id !== paperId) return;
    state.annotations = annotations; state.savedAnnotations = savedAnnotations;
    updateAnnotationControls();
    renderAllHighlights();
    renderNotes();
  } catch (error) { showToast(`筆記讀取失敗：${error.message}`); }
}

function renderPageHighlights(pageElement) {
  if (!pageElement) return;
  const pageNumber = Number(pageElement.dataset.page);
  let layer = pageElement.querySelector('.hl-layer');
  if (!layer) {
    layer = Object.assign(document.createElement('div'), { className: 'hl-layer' });
    // Under the text layer so selecting/copying text over a highlight still works.
    const textLayer = pageElement.querySelector('.textLayer');
    textLayer ? pageElement.insertBefore(layer, textLayer) : pageElement.append(layer);
  }
  layer.replaceChildren(...state.annotations.filter((item) => item.page === pageNumber && item.variant === state.pdfVariant && item.type !== 'text').flatMap((item) => item.rects.map((rect) => {
    const mark = Object.assign(document.createElement('div'), { className: `hl-rect hl-${item.color}${item.note ? ' has-note' : ''}` });
    mark.dataset.id = item.id;
    Object.assign(mark.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` });
    return mark;
  })));
  renderTextAnnotations(pageElement);
}

function renderAllHighlights() {
  for (const page of $('pdfPages').children) if (page.dataset.rendered) renderPageHighlights(page);
}

// Per-line rectangles of the selection on one page, normalized and merged.
function selectionRects(range, pageElement) {
  const pageRect = pageElement.getBoundingClientRect();
  // Only line-sized boxes: the selection range can also contain the full-page endOfContent helper.
  const lineLimit = pageRect.height * 0.05;
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 1 && rect.height > 2 && rect.height <= lineLimit && rect.width < pageRect.width * 0.95)
    .filter((rect) => rect.left + rect.width / 2 >= pageRect.left && rect.left + rect.width / 2 <= pageRect.right && rect.top + rect.height / 2 >= pageRect.top && rect.top + rect.height / 2 <= pageRect.bottom)
    .map((rect) => ({ x: (rect.left - pageRect.left) / pageRect.width, y: (rect.top - pageRect.top) / pageRect.height, w: rect.width / pageRect.width, h: rect.height / pageRect.height }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const merged = [];
  for (const rect of rects) {
    const last = merged[merged.length - 1];
    // Same line (vertical overlap) and touching/overlapping horizontally → one rectangle.
    if (last && Math.abs(last.y - rect.y) < last.h * 0.5 && rect.x <= last.x + last.w + 0.01) {
      const right = Math.max(last.x + last.w, rect.x + rect.w);
      const bottom = Math.max(last.y + last.h, rect.y + rect.h);
      last.y = Math.min(last.y, rect.y); last.x = Math.min(last.x, rect.x);
      last.w = right - last.x; last.h = bottom - last.y;
    } else merged.push({ ...rect });
  }
  return merged;
}

// Turn the current PDF text selection into a pending highlight (page, per-line rects, text).
function capturePendingSelection() {
  const selection = window.getSelection();
  if (state.cropMode || !selection?.rangeCount || selection.isCollapsed || !$('pdfPages').contains(selection.anchorNode)) return null;
  const range = selection.getRangeAt(0);
  const node = selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement;
  // Editing a text annotation must not create a PDF highlight selection.
  if (node?.closest('.text-annotation')) return null;
  const page = node?.closest('.pdf-page');
  const text = selection.toString().replace(/\s+/g, ' ').trim();
  if (!page || !text) return null;
  const rects = selectionRects(range, page);
  if (!rects.length) return null;
  state.pendingSelection = { page: Number(page.dataset.page), rects, text };
  return { range, pending: state.pendingSelection };
}

function showSelectionToolbar() {
  if (state.suppressToolbar) return;
  const captured = capturePendingSelection();
  if (!captured) return hideSelectionToolbar();
  const { range } = captured;
  // Kept for 「¶ 整段」, since pressing a toolbar button can disturb the live selection.
  state.toolbarRange = range.cloneRange();
  const box = range.getBoundingClientRect();
  const toolbar = $('selectionToolbar');
  toolbar.hidden = false;
  const width = toolbar.offsetWidth;
  const top = box.top - toolbar.offsetHeight - 10;
  toolbar.style.left = `${Math.min(window.innerWidth - width - 8, Math.max(8, box.left + box.width / 2 - width / 2))}px`;
  toolbar.style.top = `${top < 8 ? box.bottom + 10 : top}px`;
}

function hideSelectionToolbar() {
  $('selectionToolbar').hidden = true;
}

async function createHighlight(color, { openNote = false } = {}) {
  const pending = state.pendingSelection;
  if (!pending || !state.selectedPaper) return;
  const created = await changeAnnotation(null, { ...pending, color, variant: state.pdfVariant });
  if (!created) return;
  window.getSelection()?.removeAllRanges(); hideSelectionToolbar(); state.pendingSelection = null;
  if (openNote) openHighlightPopover(created.id);
}

function annotationAt(pageNumber, x, y) {
  return state.annotations.find((item) => item.page === pageNumber && item.variant === state.pdfVariant
    && item.type !== 'text' && item.rects.some((rect) => x >= rect.x && x <= rect.x + rect.w && y >= rect.y - 0.002 && y <= rect.y + rect.h + 0.002));
}

function openHighlightPopover(id, anchor) {
  const item = state.annotations.find((annotation) => annotation.id === id);
  if (!item) return;
  state.openAnnotationId = id;
  $('highlightPage').textContent = `第 ${item.page} 頁 · ${COLOR_NAMES[item.color]}色螢光筆`;
  $('highlightText').textContent = item.text;
  $('highlightNote').value = item.note || '';
  for (const swatch of document.querySelectorAll('#highlightPopover .swatch')) swatch.classList.toggle('active', swatch.dataset.color === item.color);
  const popover = $('highlightPopover');
  popover.hidden = false;
  // Place next to the first highlighted line (or the click point).
  const mark = document.querySelector(`.hl-rect[data-id="${id}"]`);
  const box = anchor || mark?.getBoundingClientRect() || { left: window.innerWidth / 2, bottom: 120, top: 120 };
  const left = Math.min(window.innerWidth - popover.offsetWidth - 8, Math.max(8, box.left));
  const below = box.bottom + 8;
  popover.style.left = `${left}px`;
  popover.style.top = `${below + popover.offsetHeight > window.innerHeight - 8 ? Math.max(8, box.top - popover.offsetHeight - 8) : below}px`;
  $('highlightNote').focus();
}

function closeHighlightPopover() {
  $('highlightPopover').hidden = true;
  state.openAnnotationId = null;
}

// Serialize mutations so history reflects server order and stale paper responses cannot alter the new reader.
async function changeAnnotation(before, after, record = true, enqueue = true) {
  const paperId = state.selectedPaper?.id;
  if (!paperId) return null;
  const operation = async () => {
    try {
      const id = before?.id || after?.id;
      const method = !before ? 'POST' : !after ? 'DELETE' : 'PATCH';
      const result = await request(`/api/papers/${paperId}/annotations${method === 'POST' ? '' : `/${id}`}`, {
        method, headers: { 'content-type': 'application/json' }, ...(after ? { body: JSON.stringify(after) } : {}),
      });
      if (state.selectedPaper?.id !== paperId) return null;
      const updated = after ? result : null;
      state.annotations = state.annotations.filter((item) => item.id !== id && item.id !== updated?.id);
      if (updated) state.annotations.push(updated);
      if (record) state.annotationHistory = recordChange(state.annotationHistory, before, updated);
      renderAllHighlights(); renderNotes(); updateAnnotationControls();
      return updated || before;
    } catch (error) { if (state.selectedPaper?.id === paperId) showToast(error.message); return null; }
  };
  if (!enqueue) return operation();
  const pending = state.annotationQueue.then(operation); state.annotationQueue = pending.catch(() => {});
  return pending;
}
async function updateAnnotation(id, patch) {
  const paperId = state.selectedPaper?.id;
  // Resolve the snapshot after preceding edits finish so rapid color changes undo in order.
  const pending = state.annotationQueue.then(() => {
    if (state.selectedPaper?.id !== paperId) return null;
    const item = state.annotations.find((annotation) => annotation.id === id);
    return item && changeAnnotation(item, { ...item, ...patch }, true, false);
  });
  state.annotationQueue = pending.catch(() => {});
  return pending;
}
async function deleteAnnotation(id) {
  const paperId = state.selectedPaper?.id;
  // Capture the delete snapshot after preceding style edits, and leave other editors open.
  const pending = state.annotationQueue.then(async () => {
    if (state.selectedPaper?.id !== paperId) return;
    const item = state.annotations.find((annotation) => annotation.id === id);
    if (!item || !(await changeAnnotation(item._original || item, null, true, false))) return;
    if (state.openAnnotationId === id) closeHighlightPopover();
    if (state.editingTextId === id) { state.editingTextId = null; $('textAnnotationToolbar').hidden = true; }
  });
  state.annotationQueue = pending.catch(() => {});
  return pending;
}

const VARIANT_NAMES = { original: '原文', chinese: '中文', bilingual: '雙語' };

function renderNotes() {
  const items = [...state.annotations].sort((a, b) => a.page - b.page || (a.type === 'text' ? a.y : a.rects[0]?.y ?? 0) - (b.type === 'text' ? b.y : b.rects[0]?.y ?? 0));
  const withNotes = items.filter((item) => item.note).length;
  $('notesCount').textContent = items.length ? `${items.length} 個重點 · ${withNotes} 則註記` : '';
  $('tabNotes').textContent = items.length ? `筆記 ${items.length}` : '筆記';
  if (!items.length) {
    $('notesList').innerHTML = '<p class="muted">在 PDF 上選取文字，從浮出的工具列選一個顏色即可畫重點；點一下螢光筆可以寫註記。</p>';
    return;
  }
  $('notesList').replaceChildren(...items.map((item) => {
    if (item.type === 'text') {
      const row = document.createElement('div'); row.className = 'note-item';
      const jump = document.createElement('button'); jump.type = 'button'; jump.textContent = `文字 · 第 ${item.page} 頁 · ${VARIANT_NAMES[item.variant] || item.variant}：${item.text}`;
      jump.addEventListener('click', () => goToAnnotation(item));
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '編輯'; edit.addEventListener('click', () => goToAnnotation(item, true));
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '刪除'; remove.addEventListener('click', () => deleteAnnotation(item.id));
      row.append(jump, edit, remove); return row;
    }
    const button = Object.assign(document.createElement('button'), { type: 'button', className: `note-item color-${item.color}` });
    button.innerHTML = `<small>第 ${item.page} 頁 · ${VARIANT_NAMES[item.variant] || item.variant}</small><q>${escapeHtml(item.text)}</q>${item.note ? `<p>✎ ${escapeHtml(item.note)}</p>` : ''}`;
    button.addEventListener('click', () => goToAnnotation(item));
    return button;
  }));
}

async function goToAnnotation(item, edit = false) {
  if (state.pdfVariant !== item.variant) {
    if (![...$('pdfVariant').options].some((option) => option.value === item.variant)) return showToast('這個重點畫在另一個 PDF 版本上，該版本目前不存在');
    $('pdfVariant').value = item.variant;
    await switchPdfVariant();
  }
  scrollToPage(item.page);
  // Pages render lazily; wait a moment before flashing the marks.
  window.setTimeout(() => {
    const page = $('pdfPages').children[item.page - 1];
    renderPageHighlights(page);
    if (item.type === 'text') { if (edit) selectTextAnnotation(item.id, true); else page?.querySelector(`[data-text-id="${item.id}"]`)?.scrollIntoView({ block: 'center' }); return; }
    for (const mark of page.querySelectorAll(`.hl-rect[data-id="${item.id}"]`)) { mark.classList.remove('flash'); void mark.offsetWidth; mark.classList.add('flash'); }
  }, 400);
}

async function exportAnnotated() {
  if (state.editingTextId && !(await commitTextAnnotation(state.editingTextId))) return;
  await state.annotationQueue;
  if (!state.selectedPaper) return showToast('請先選擇一篇論文');
  const count = state.annotations.filter((item) => item.variant === state.pdfVariant).length;
  if (!count) return showToast(`目前的「${VARIANT_NAMES[state.pdfVariant]}」版本還沒有標註`);
  const paper = state.selectedPaper;
  try {
    // Read errors before downloading so a missing font never navigates away from the reader.
    const response = await fetch(`/api/papers/${paper.id}/export-annotated?variant=${state.pdfVariant}`);
    if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || `匯出失敗：HTTP ${response.status}`); }
    const url = URL.createObjectURL(await response.blob());
    const link = Object.assign(document.createElement('a'), { href: url, download: `${paper.title || 'paper'}_標註.pdf` });
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    showToast(`已匯出 ${count} 個標註到 PDF（Adobe 可直接開啟與編輯）`);
  } catch (error) { showToast(error.message); }
}

// Clicking a highlight opens its note editor before element/selection handlers run.
$('pdfPages').addEventListener('click', (event) => {
  if (state.cropMode || state.textMode || event.target.closest?.('.text-annotation') || window.getSelection()?.toString().trim()) return;
  const point = pointerOnPage(event);
  const item = point && annotationAt(point.pageNumber, point.x, point.y);
  if (!item) return;
  event.stopPropagation();
  openHighlightPopover(item.id, { left: event.clientX, top: event.clientY, bottom: event.clientY + 12 });
}, true);
$('pdfPages').addEventListener('mouseup', () => window.setTimeout(showSelectionToolbar, 0));
document.addEventListener('selectionchange', () => { if (window.getSelection()?.isCollapsed) hideSelectionToolbar(); });
$('readerStage').addEventListener('scroll', hideSelectionToolbar);
$('selectionToolbar').addEventListener('mousedown', (event) => event.preventDefault()); // keep the selection
for (const swatch of document.querySelectorAll('#selectionToolbar .swatch')) swatch.addEventListener('click', () => createHighlight(swatch.dataset.color));
$('selectionNote').addEventListener('click', () => createHighlight('yellow', { openNote: true }));
// Expand the current selection to the whole paragraph(s) it touches.
$('selectionParagraph').addEventListener('click', () => {
  const range = state.toolbarRange;
  if (!range) return;
  selectParagraphs(spanAtNode(range.startContainer), spanAtNode(range.endContainer) || spanAtNode(range.startContainer));
});
$('selectionExplain').addEventListener('click', () => {
  hideSelectionToolbar();
  const action = [...$('attachmentActions').querySelectorAll('button')].find((button) => /^解釋/.test(button.textContent));
  action ? action.click() : showToast('請先選取文字');
});
$('highlightClose').addEventListener('click', closeHighlightPopover);
$('highlightSave').addEventListener('click', async () => {
  if (!state.openAnnotationId) return;
  if (await updateAnnotation(state.openAnnotationId, { note: $('highlightNote').value.trim() })) { closeHighlightPopover(); showToast('註記已儲存'); }
});
$('highlightNote').addEventListener('keydown', (event) => { if (event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); $('highlightSave').click(); } if (event.key === 'Escape') closeHighlightPopover(); });
for (const swatch of document.querySelectorAll('#highlightPopover .swatch')) {
  swatch.addEventListener('click', async () => {
    if (!state.openAnnotationId) return;
    await updateAnnotation(state.openAnnotationId, { color: swatch.dataset.color });
    for (const other of document.querySelectorAll('#highlightPopover .swatch')) other.classList.toggle('active', other === swatch);
    $('highlightPage').textContent = $('highlightPage').textContent.replace(/· .*色螢光筆/, `· ${COLOR_NAMES[swatch.dataset.color]}色螢光筆`);
  });
}
$('highlightDelete').addEventListener('click', () => { if (state.openAnnotationId) deleteAnnotation(state.openAnnotationId); });
$('highlightAsk').addEventListener('click', (event) => {
  const item = state.annotations.find((annotation) => annotation.id === state.openAnnotationId);
  if (!item) return;
  closeHighlightPopover();
  state.selectedText = item.text;
  // The note travels with the question so the assistant sees what you were thinking.
  setAttachment({ kind: 'passage', page: item.page, text: item.note ? `${item.text}\n\n（我的註記：${item.note}）` : item.text, label: `「${item.text.slice(0, 28)}${item.text.length > 28 ? '…' : ''}」`, meta: `第 ${item.page} 頁 · 螢光筆重點`, thumb: null }, event.ctrlKey || event.metaKey);
  showAssistantTab('chat');
  flashAttachmentCard();
});
document.addEventListener('mousedown', (event) => {
  if (!$('highlightPopover').hidden && !$('highlightPopover').contains(event.target) && !event.target.closest?.('.pdf-page')) closeHighlightPopover();
});
$('tabNotes').addEventListener('click', () => showAssistantTab('notes'));
$('exportAnnotated').addEventListener('click', exportAnnotated);
$('exportAnnotatedFromNotes').addEventListener('click', exportAnnotated);

// ---------------------------------------------------------------------------
// Text boxes use PDF-relative coordinates; their font size follows the rendered page scale.
const TEXT_FONTS = ['Microsoft JhengHei', 'DFKai-SB', 'PMingLiU', 'Noto Sans TC', 'Noto Serif TC', 'Arial', 'Times New Roman', 'Georgia', 'Consolas'];
// Keep CSS family identifiers stable while presenting familiar local names.
const TEXT_FONT_LABELS = { 'Microsoft JhengHei': '微軟正黑體', 'DFKai-SB': '標楷體', 'PMingLiU': '新細明體', 'Noto Sans TC': 'Noto Sans TC（黑體）', 'Noto Serif TC': 'Noto Serif TC（明體）' };
// FontFaceSet.check alone reports success for missing system fonts via fallback.
const fontContext = document.createElement('canvas').getContext('2d');
function hasSystemFont(font) {
  if (document.fonts && !document.fonts.check(`12px "${font}"`)) return false;
  if (!fontContext) return false;
  const sample = '測試字型 ABCDEFG abcdefg 1234567890';
  return ['monospace', 'serif'].some((fallback) => {
    fontContext.font = `32px ${fallback}`; const base = fontContext.measureText(sample).width;
    fontContext.font = `32px "${font}", ${fallback}`;
    return Math.abs(fontContext.measureText(sample).width - base) > 0.01;
  });
}
for (const font of TEXT_FONTS) {
  if (hasSystemFont(font)) $('textFont').add(new Option(TEXT_FONT_LABELS[font] || font, font));
}
if (!$('textFont').options.length) $('textFont').add(new Option('Arial', 'Arial'));
function annotationSnapshot(items) {
  // Server timestamps do not change the appearance of the exported PDF.
  return JSON.stringify((items || []).map((item) => Object.fromEntries(Object.entries({ type: 'highlight', ...item }).filter(([key]) => !key.startsWith('_') && !['createdAt', 'updatedAt'].includes(key)).sort(([a], [b]) => a.localeCompare(b)))).sort((a, b) => a.id.localeCompare(b.id)));
}
function updateAnnotationControls() {
  $('annotationUndo').disabled = !state.annotationHistory?.undo.length;
  $('annotationRedo').disabled = !state.annotationHistory?.redo.length;
  $('textAnnotationMode').classList.toggle('active', !!state.textMode);
  const current = (state.annotations || []).filter((item) => item.variant === state.pdfVariant && (!item._draft || item.text.trim()));
  $('annotationDirty').hidden = !(state.selectedPaper && annotationSnapshot(current) !== annotationSnapshot(state.savedAnnotations?.[state.pdfVariant]));
}
function renderTextAnnotations(page) {
  // Keep a live editor intact when an unrelated annotation finishes saving.
  const activeBox = [...page.querySelectorAll('.text-annotation')].find((node) => node.dataset.textId === state.editingTextId && state.annotations.includes(node.annotationItem) && !node.annotationItem._committing);
  page.querySelectorAll('.text-annotation').forEach((node) => { if (node !== activeBox) node.remove(); });
  for (const item of state.annotations.filter((entry) => entry.type === 'text' && entry.page === Number(page.dataset.page) && entry.variant === state.pdfVariant)) {
    if (activeBox?.annotationItem === item) continue;
    const box = document.createElement('div'); box.className = 'text-annotation'; box.dataset.textId = item.id;
    box.annotationItem = item;
    box.classList.toggle('selected', state.editingTextId === item.id);
    // The viewport scale converts PDF points to CSS pixels, including rotated pages.
    const scale = state.zoom * 1.35;
    Object.assign(box.style, { left: `${item.x * 100}%`, top: `${item.y * 100}%`, width: `${item.w * 100}%`, color: item.color, fontFamily: `"${item.font}", "Microsoft JhengHei", "Noto Sans TC", sans-serif`, fontSize: `${item.size * scale}px`, padding: `${2 * scale}px`, lineHeight: '1.25', fontWeight: item.bold ? 'bold' : 'normal', fontStyle: item.italic ? 'italic' : 'normal', background: item.background === 'yellow' ? '#fff59d' : 'transparent' });
    const content = document.createElement('div'); content.className = 'text-annotation-content'; content.contentEditable = 'true'; content.spellcheck = false; content.textContent = item.text;
    content.addEventListener('focus', () => { if (!item._draft && !item._original) item._original = { ...item }; selectTextAnnotation(item.id); });
    content.addEventListener('input', () => { item.text = content.innerText.replace(/\r/g, ''); item.h = Math.min(1 - item.y, Math.max(.01, box.offsetHeight / page.clientHeight)); updateAnnotationControls(); });
    content.addEventListener('blur', () => window.setTimeout(() => {
      const active = document.activeElement;
      if (active === content || $('textAnnotationToolbar').contains(active) || box.contains(active)) return;
      commitTextAnnotation(item.id);
    }, 0));
    const handle = document.createElement('span'); handle.className = 'text-annotation-handle'; handle.textContent = '移動';
    const resize = document.createElement('span'); resize.className = 'text-annotation-resize';
    for (const [control, moving] of [[handle, true], [resize, false]]) control.addEventListener('pointerdown', (event) => {
      event.preventDefault(); event.stopPropagation(); if (!item._draft && !item._original) item._original = { ...item }; selectTextAnnotation(item.id); control.setPointerCapture(event.pointerId);
      const startX = event.clientX, startY = event.clientY, initial = { x: item.x, y: item.y, w: item.w };
      control.onpointermove = (move) => {
        if (moving) { item.x = Math.max(0, Math.min(1 - item.w, initial.x + (move.clientX - startX) / page.clientWidth)); item.y = Math.max(0, Math.min(1 - item.h, initial.y + (move.clientY - startY) / page.clientHeight)); }
        else item.w = Math.max(.05, Math.min(1 - item.x, initial.w + (move.clientX - startX) / page.clientWidth));
        Object.assign(box.style, { left: `${item.x * 100}%`, top: `${item.y * 100}%`, width: `${item.w * 100}%` });
      };
      control.onpointerup = () => { control.onpointermove = null; item.h = Math.min(1 - item.y, Math.max(.01, box.offsetHeight / page.clientHeight)); commitTextAnnotation(item.id, false); };
    });
    box.append(content, handle, resize); page.append(box);
  }
}
function selectTextAnnotation(id, focus = false) {
  const item = state.annotations.find((entry) => entry.id === id); if (!item) return;
  state.editingTextId = id;
  document.querySelectorAll('.text-annotation').forEach((box) => box.classList.toggle('selected', box.dataset.textId === id));
  const box = [...document.querySelectorAll('.text-annotation')].find((node) => node.dataset.textId === id); if (!box) return;
  const toolbar = $('textAnnotationToolbar'); toolbar.hidden = false;
  $('textColor').value = item.color; $('textCustomColor').value = item.color;
  if (![...$('textFont').options].some((option) => option.value === item.font)) $('textFont').add(new Option(TEXT_FONT_LABELS[item.font] || item.font, item.font));
  $('textFont').value = item.font; $('textSize').value = item.size; $('textBackground').value = item.background;
  $('textBold').classList.toggle('active', item.bold); $('textItalic').classList.toggle('active', item.italic);
  const rect = box.getBoundingClientRect(); toolbar.style.left = `${Math.max(8, Math.min(innerWidth - toolbar.offsetWidth - 8, rect.left))}px`; toolbar.style.top = `${Math.max(8, rect.top - toolbar.offsetHeight - 10)}px`;
  if (focus) box.querySelector('.text-annotation-content').focus();
}
function commitTextAnnotation(id, close = true) {
  // A number input fires change after outside pointerdown; flush its value before closing the editor.
  if (state.editingTextId === id && document.activeElement === $('textSize')) {
    styleText({ size: Math.min(48, Math.max(8, Number($('textSize').value) || 14)) });
  }
  if (state.annotationCommits.has(id)) return state.annotationCommits.get(id);
  const paperId = state.selectedPaper?.id;
  // Blur and outside-pointer events can arrive together; share one queued transaction.
  const pending = state.annotationQueue.then(async () => {
    if (state.selectedPaper?.id !== paperId) return false;
    const item = state.annotations.find((entry) => entry.id === id); if (!item) return true;
    const box = [...document.querySelectorAll('.text-annotation')].find((node) => node.dataset.textId === id);
    if (box) {
      item.h = Math.min(1, Math.max(.01, box.offsetHeight / box.parentElement.clientHeight));
      item.y = Math.min(item.y, 1 - item.h);
    }
    const before = item._original || (item._draft ? null : { ...item });
    const { _draft, _original, _committing, ...after } = item;
    let result = true;
    if (!after.text.trim()) {
      if (before) result = await changeAnnotation(before, null, true, false);
      else { state.annotations = state.annotations.filter((entry) => entry !== item); renderAllHighlights(); }
    } else if (!sameAnnotation(before, after)) {
      item._committing = true;
      result = await changeAnnotation(before, after, true, false);
      if (!result) item._committing = false;
      else if (!close) result._original = { ...result };
    }
    if (!result) return false;
    if (close && state.editingTextId === id) { state.editingTextId = null; $('textAnnotationToolbar').hidden = true; renderAllHighlights(); }
    return true;
  });
  state.annotationCommits.set(id, pending);
  state.annotationQueue = pending.catch(() => false);
  pending.finally(() => { if (state.annotationCommits.get(id) === pending) state.annotationCommits.delete(id); });
  return pending;
}
$('textAnnotationMode').addEventListener('click', () => { state.textMode = !state.textMode; updateAnnotationControls(); });
$('pdfPages').addEventListener('click', (event) => {
  if (!state.textMode || event.target.closest('.text-annotation')) return;
  const point = pointerOnPage(event); if (!point) return;
  event.stopPropagation();
  const item = { id: crypto.randomUUID(), type: 'text', variant: state.pdfVariant, page: point.pageNumber, x: Math.min(.75, point.x), y: Math.min(.95, point.y), w: .25, h: .04, text: '', color: '#000000', font: $('textFont').value, size: 14, bold: false, italic: false, background: 'none', _draft: true };
  state.annotations.push(item); state.textMode = false; state.editingTextId = item.id; updateAnnotationControls(); renderAllHighlights(); selectTextAnnotation(item.id, true);
}, true);
function styleText(patch) {
  const item = state.annotations.find((entry) => entry.id === state.editingTextId); if (!item) return;
  // Ignore the duplicate change event after a pending number field was flushed during blur.
  if (Object.entries(patch).every(([key, value]) => item[key] === value)) return;
  if (!item._draft && !item._original) item._original = { ...item };
  Object.assign(item, patch);
  const page = $('pdfPages').children[item.page - 1];
  const box = [...(page?.querySelectorAll('.text-annotation') || [])].find((node) => node.dataset.textId === item.id);
  // Update the existing contenteditable node so native text undo and caret survive styling.
  if (box) {
    Object.assign(box.style, { color: item.color, fontFamily: `"${item.font}", "Microsoft JhengHei", "Noto Sans TC", sans-serif`, fontSize: `${item.size * state.zoom * 1.35}px`, fontWeight: item.bold ? 'bold' : 'normal', fontStyle: item.italic ? 'italic' : 'normal', background: item.background === 'yellow' ? '#fff59d' : 'transparent' });
    item.h = Math.min(1, Math.max(.01, box.offsetHeight / page.clientHeight));
    item.y = Math.min(item.y, 1 - item.h); box.style.top = `${item.y * 100}%`;
  }
  updateAnnotationControls(); selectTextAnnotation(item.id);
  if (item._draft) return;
  const paperId = state.selectedPaper.id; const height = item.h; const y = item.y;
  // Each style intent is resolved against the preceding saved snapshot inside the queue.
  const pending = state.annotationQueue.then(async () => {
    if (state.selectedPaper?.id !== paperId) return;
    const current = state.annotations.find((entry) => entry.id === item.id); if (!current) return;
    const before = current._original || { ...current };
    try {
      const updated = await request(`/api/papers/${paperId}/annotations/${item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...patch, h: height, y }) });
      if (state.selectedPaper?.id !== paperId) return;
      const live = state.annotations.find((entry) => entry.id === item.id);
      if (live) live._original = { ...updated };
      state.annotationHistory = recordChange(state.annotationHistory, before, updated);
      renderNotes(); updateAnnotationControls();
    } catch (error) { if (state.selectedPaper?.id === paperId) showToast(error.message); }
  });
  state.annotationQueue = pending.catch(() => {});
}
for (const [id, field] of [['textColor', 'color'], ['textCustomColor', 'color'], ['textFont', 'font'], ['textBackground', 'background']]) $(id).addEventListener('change', () => styleText({ [field]: $(id).value }));
$('textSize').addEventListener('change', () => styleText({ size: Math.min(48, Math.max(8, Number($('textSize').value) || 14)) }));
for (const [id, field] of [['textBold', 'bold'], ['textItalic', 'italic']]) $(id).addEventListener('click', () => { const item = state.annotations.find((entry) => entry.id === state.editingTextId); if (item) styleText({ [field]: !item[field] }); });
$('textDelete').addEventListener('click', () => { const item = state.annotations.find((entry) => entry.id === state.editingTextId); if (item?._draft) { state.annotations = state.annotations.filter((entry) => entry !== item); state.editingTextId = null; $('textAnnotationToolbar').hidden = true; renderAllHighlights(); renderNotes(); updateAnnotationControls(); } else if (item) deleteAnnotation(item.id); });
document.addEventListener('pointerdown', (event) => { if (state.editingTextId && !event.target.closest?.('.text-annotation, .text-annotation-toolbar')) commitTextAnnotation(state.editingTextId); });
function historyStep(direction) {
  const paperId = state.selectedPaper?.id;
  // Compute and apply each step inside the same queue as ordinary edits.
  const pending = state.annotationQueue.then(async () => {
    if (!paperId || state.selectedPaper?.id !== paperId) return;
    const { change, history } = stepHistory(state.annotationHistory, direction); if (!change) return;
    const before = direction === 'undo' ? change.after : change.before; const after = direction === 'undo' ? change.before : change.after;
    if (await changeAnnotation(before, after, false, false) && state.selectedPaper?.id === paperId) { state.annotationHistory = history; updateAnnotationControls(); }
  });
  state.annotationQueue = pending.catch(() => {});
  return pending;
}
$('annotationUndo').addEventListener('click', () => historyStep('undo'));
$('annotationRedo').addEventListener('click', () => historyStep('redo'));
async function saveAnnotated() {
  if (!state.selectedPaper) return showToast('請先選擇論文');
  const paperId = state.selectedPaper.id, variant = state.pdfVariant;
  if (state.editingTextId && !(await commitTextAnnotation(state.editingTextId))) return;
  await state.annotationQueue;
  if (state.selectedPaper?.id !== paperId) return;
  try {
    const result = await request(`/api/papers/${paperId}/save-annotated`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ variant }) });
    if (state.selectedPaper?.id !== paperId) return;
    state.savedAnnotations[variant] = result.savedAnnotations || []; updateAnnotationControls();
    const toast = document.getElementById('toast'); showToast(`已儲存：${result.path}${result.warnings?.length ? `\n${result.warnings.join('；')}` : ''}`);
    toast.classList.add('has-action'); const button = document.createElement('button'); button.textContent = '開啟資料夾';
    button.addEventListener('click', async () => { try { await request(`/api/papers/${paperId}/open-export-folder`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: result.path }) }); } catch (error) { showToast(error.message); } }); toast.append(' ', button);
  } catch (error) { showToast(error.message); }
}
$('saveAnnotated').addEventListener('click', saveAnnotated);
document.addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229 || !$('settingsView').hidden || !$('tourOverlay').hidden || document.querySelector('dialog[open]')) return;
  const editing = event.target.closest?.('input, textarea, select, [contenteditable="true"]');
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveAnnotated(); return; }
  if (editing) return;
  if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); historyStep(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo'); }
  else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 't' && state.selectedPaper) { event.preventDefault(); $('textAnnotationMode').click(); }
});

// ---------------------------------------------------------------------------
// Quick highlight shortcuts: left-drag + right click, mouse side buttons, or the H key.
// The default color is yellow; right-click a swatch in the toolbar to change it.
// ---------------------------------------------------------------------------

const DEFAULT_COLOR_KEY = 'paper-reader.highlight.default';
function defaultHighlightColor() {
  try { return COLOR_NAMES[localStorage.getItem(DEFAULT_COLOR_KEY)] ? localStorage.getItem(DEFAULT_COLOR_KEY) : 'yellow'; } catch { return 'yellow'; }
}
function markDefaultSwatch() {
  const color = defaultHighlightColor();
  for (const swatch of document.querySelectorAll('#selectionToolbar .swatch')) {
    swatch.classList.toggle('default', swatch.dataset.color === color);
    swatch.title = `${COLOR_NAMES[swatch.dataset.color]}色螢光筆${swatch.dataset.color === color ? '（預設，快捷鍵使用）' : '（右鍵設為預設）'}`;
  }
}

// Highlight the live selection with the default color; returns true when something was drawn.
async function quickHighlight(source) {
  if (!state.selectedPaper || !capturePendingSelection()) return false;
  const color = defaultHighlightColor();
  // Keep the toolbar from reappearing for the selection that was just consumed.
  state.suppressToolbar = true;
  await createHighlight(color);
  window.setTimeout(() => { state.suppressToolbar = false; }, 400);
  showToast(`已用${COLOR_NAMES[color]}色畫重點（${source}）`);
  return true;
}

let chordUntil = 0;
// Right button pressed while the left button is still selecting: highlight immediately.
$('pdfPages').addEventListener('mousedown', (event) => {
  if (event.button === 2 && (event.buttons & 1)) {
    event.preventDefault();
    chordUntil = Date.now() + 1500;
    quickHighlight('左鍵＋右鍵');
  }
});
// Swallow the context menu that the chord's right click would otherwise open.
document.addEventListener('contextmenu', (event) => {
  if (Date.now() < chordUntil) event.preventDefault();
});
// Mouse side buttons (3 = back, 4 = forward): highlight, and never navigate away from the reader.
const sideButton = (event) => event.button === 3 || event.button === 4;
window.addEventListener('mousedown', (event) => { if (sideButton(event)) event.preventDefault(); });
window.addEventListener('mouseup', async (event) => {
  if (!sideButton(event)) return;
  event.preventDefault();
  if (!(await quickHighlight('側鍵'))) showToast('先在 PDF 上選取文字，再按側鍵畫重點');
});
window.addEventListener('auxclick', (event) => { if (sideButton(event)) event.preventDefault(); });
// H key with an active PDF selection (ignored while typing in inputs).
document.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 'h' || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  if (window.getSelection()?.isCollapsed) return;
  event.preventDefault();
  quickHighlight('H 鍵');
});
// Right-click a toolbar swatch to make it the default shortcut color.
for (const swatch of document.querySelectorAll('#selectionToolbar .swatch')) {
  swatch.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    try { localStorage.setItem(DEFAULT_COLOR_KEY, swatch.dataset.color); } catch { /* Preference stays for this session only. */ }
    markDefaultSwatch();
    showToast(`預設螢光筆改為${COLOR_NAMES[swatch.dataset.color]}色`);
  });
}
markDefaultSwatch();


// ---------------------------------------------------------------------------
// Layout: collapsible library sidebar and a detachable assistant window.
// ---------------------------------------------------------------------------

const LAYOUT_KEY = 'paper-reader.layout.v1';
function readLayout() {
  try { return { leftCollapsed: false, floating: false, rect: null, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') }; }
  catch { return { leftCollapsed: false, floating: false, rect: null }; }
}
function writeLayout(patch) {
  const next = { ...readLayout(), ...patch };
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)); } catch { /* Layout resets next visit. */ }
  return next;
}

function setLeftCollapsed(collapsed) {
  $('appShell').classList.toggle('left-collapsed', collapsed);
  writeLayout({ leftCollapsed: collapsed });
}

const assistantPanel = document.querySelector('.right-sidebar');
// Keep the floating window fully reachable inside the viewport.
function clampRect(rect) {
  const width = Math.min(Math.max(320, rect.width), window.innerWidth - 16);
  const height = Math.min(Math.max(360, rect.height), window.innerHeight - 16);
  return { width, height, left: Math.min(Math.max(8, rect.left), window.innerWidth - width - 8), top: Math.min(Math.max(8, rect.top), window.innerHeight - height - 8) };
}
function applyFloatingRect(rect) {
  const clamped = clampRect(rect);
  Object.assign(assistantPanel.style, { left: `${clamped.left}px`, top: `${clamped.top}px`, width: `${clamped.width}px`, height: `${clamped.height}px` });
  return clamped;
}

function setAssistantFloating(floating) {
  $('appShell').classList.toggle('assistant-floating', floating);
  assistantPanel.classList.toggle('floating', floating);
  $('floatAssistant').textContent = floating ? '⇥' : '⧉';
  $('floatAssistant').title = floating ? '放回右側' : '拉出成浮動視窗（拖到最右邊會自動放回）';
  if (floating) {
    const saved = readLayout().rect;
    applyFloatingRect(saved || { left: window.innerWidth - 460, top: 80, width: 420, height: Math.min(720, window.innerHeight - 120) });
  } else {
    // Docked: drop inline geometry so the grid column controls the size again.
    for (const key of ['left', 'top', 'width', 'height']) assistantPanel.style[key] = '';
  }
  writeLayout({ floating });
}

// Drag the floating window by its header; releasing near the right edge docks it back.
(function setupAssistantDrag() {
  const header = assistantPanel.querySelector('.chat-header');
  let drag = null;
  header.addEventListener('pointerdown', (event) => {
    if (!assistantPanel.classList.contains('floating') || event.button !== 0 || event.target.closest('button, select, input, textarea')) return;
    const box = assistantPanel.getBoundingClientRect();
    drag = { dx: event.clientX - box.left, dy: event.clientY - box.top, width: box.width, height: box.height };
    header.setPointerCapture(event.pointerId);
    assistantPanel.classList.add('dragging');
    document.body.style.userSelect = 'none';
  });
  header.addEventListener('pointermove', (event) => {
    if (!drag) return;
    applyFloatingRect({ left: event.clientX - drag.dx, top: event.clientY - drag.dy, width: drag.width, height: drag.height });
    $('dockHint').hidden = event.clientX < window.innerWidth - 40;
  });
  const end = (event) => {
    if (!drag) return;
    const dock = event.clientX >= window.innerWidth - 40;
    drag = null;
    assistantPanel.classList.remove('dragging');
    document.body.style.userSelect = '';
    $('dockHint').hidden = true;
    if (dock) { setAssistantFloating(false); showToast('論文助手已放回右側'); return; }
    const box = assistantPanel.getBoundingClientRect();
    writeLayout({ rect: { left: box.left, top: box.top, width: box.width, height: box.height } });
  };
  header.addEventListener('pointerup', end);
  header.addEventListener('pointercancel', end);
  // Remember size changes made with the native resize handle.
  new ResizeObserver(() => {
    if (!assistantPanel.classList.contains('floating') || assistantPanel.classList.contains('dragging')) return;
    const box = assistantPanel.getBoundingClientRect();
    writeLayout({ rect: { left: box.left, top: box.top, width: box.width, height: box.height } });
  }).observe(assistantPanel);
  window.addEventListener('resize', () => { if (assistantPanel.classList.contains('floating')) applyFloatingRect(assistantPanel.getBoundingClientRect()); });
}());

$('collapseLeft').addEventListener('click', () => setLeftCollapsed(true));
$('expandLeft').addEventListener('click', () => setLeftCollapsed(false));
$('railUpload').addEventListener('click', () => $('fileInput').click());
$('railHelp').addEventListener('click', () => $('helpButton').click());
$('railSettings').addEventListener('click', () => $('settingsButton').click());
$('floatAssistant').addEventListener('click', () => setAssistantFloating(!assistantPanel.classList.contains('floating')));
{
  const layout = readLayout();
  if (layout.leftCollapsed) setLeftCollapsed(true);
  if (layout.floating) setAssistantFloating(true);
}


// ---------------------------------------------------------------------------
// Pop-out assistant: moves the live panel (same JS state and listeners) into a separate window
// via Document Picture-in-Picture, so it can sit on another monitor. Closing it docks the panel back.
// ---------------------------------------------------------------------------

let pipWindow = null;
const POPOUT_BOUNDS_KEY = 'paper-reader.popout.bounds';

// Where to open the assistant window: last saved bounds, else the full area of a second monitor
// (Window Management API, asks once), else a tall window at the right edge of this screen.
async function popoutBounds() {
  try {
    const saved = JSON.parse(localStorage.getItem(POPOUT_BOUNDS_KEY) || 'null');
    if (saved && saved.width > 200 && saved.height > 200) return saved;
  } catch { /* fall through to defaults */ }
  if ('getScreenDetails' in window) {
    try {
      const details = await window.getScreenDetails();
      const other = details.screens.find((screen) => screen !== details.currentScreen);
      if (other) return { left: other.availLeft, top: other.availTop, width: other.availWidth, height: other.availHeight };
    } catch { /* permission denied or unsupported: use this screen */ }
  }
  const width = 480;
  return { left: window.screenX + window.outerWidth - width, top: window.screenY, width, height: window.outerHeight };
}

function copyStyles(targetDocument) {
  // Copy every stylesheet so the panel looks identical in the new window.
  for (const sheet of document.styleSheets) {
    try {
      const style = targetDocument.createElement('style');
      style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
      targetDocument.head.append(style);
    } catch {
      if (sheet.href) targetDocument.head.append(Object.assign(targetDocument.createElement('link'), { rel: 'stylesheet', href: sheet.href }));
    }
  }
}

// Open a normal browser window (minimize/maximize/close, movable to any monitor) and move the live
// assistant panel into it; state and listeners stay in this window, so everything keeps syncing.
// Falls back to Document Picture-in-Picture if popups are blocked.
async function popOutAssistant() {
  if (pipWindow) { pipWindow.close(); return; }
  if (assistantPanel.classList.contains('floating')) setAssistantFloating(false);
  const bounds = await popoutBounds();
  let win = window.open('/popout.html', 'paper-reader-assistant',
    `popup=yes,left=${Math.round(bounds.left)},top=${Math.round(bounds.top)},width=${Math.round(bounds.width)},height=${Math.round(bounds.height)}`);
  let usingPip = false;
  if (!win) {
    if (!('documentPictureInPicture' in window)) return showToast('瀏覽器擋下了彈出視窗，請允許此網站開啟彈出式視窗後再試');
    try { win = await documentPictureInPicture.requestWindow({ width: 480, height: Math.min(window.screen.availHeight - 80, 900) }); usingPip = true; }
    catch (error) { return showToast(`無法開啟獨立視窗：${error.message}`); }
  } else {
    // Wait for the same-origin host page before moving nodes into it.
    await new Promise((resolve) => {
      const ready = () => win.document.readyState === 'complete' && win.location.pathname.endsWith('/popout.html');
      if (ready()) return resolve();
      const timer = window.setInterval(() => { if (ready()) { window.clearInterval(timer); resolve(); } }, 30);
    });
  }
  copyStyles(win.document);
  win.document.title = '論文助手 · Paper Reader';
  win.document.body.className = 'pip-body';
  const placeholder = document.createComment('assistant-panel');
  assistantPanel.before(placeholder);
  win.document.body.append(assistantPanel);
  pipWindow = win;
  pipDocument = win.document;
  $('appShell').classList.add('assistant-popped');
  $('popoutAssistant').textContent = '↩';
  $('popoutAssistant').title = '關閉獨立視窗，放回右側';
  // Close the model menu on outside clicks inside the new window too.
  win.document.addEventListener('click', () => { $('modelMenu').hidden = true; $('modelBadge').setAttribute('aria-expanded', 'false'); });
  // Remember where the window was so it reopens on the same monitor and size.
  const saveBounds = () => {
    if (usingPip) return;
    try { localStorage.setItem(POPOUT_BOUNDS_KEY, JSON.stringify({ left: win.screenX, top: win.screenY, width: win.outerWidth, height: win.outerHeight })); } catch { /* optional */ }
  };
  win.addEventListener('beforeunload', saveBounds);
  win.addEventListener('pagehide', () => {
    saveBounds();
    placeholder.replaceWith(assistantPanel);
    pipWindow = null;
    pipDocument = null;
    $('appShell').classList.remove('assistant-popped');
    $('popoutAssistant').textContent = '🖥';
    $('popoutAssistant').title = '開成獨立視窗，可拖到另一個螢幕';
  }, { once: true });
  showToast('論文助手已開成獨立視窗：可最大化、拖到另一個螢幕；關閉視窗即放回右側');
}
// Closing or reloading the main window also closes the assistant window.
window.addEventListener('pagehide', () => pipWindow?.close());
$('popoutAssistant').addEventListener('click', popOutAssistant);

// ---------------------------------------------------------------------------
// Local reader preferences, PDF search and portable Markdown actions.
// ---------------------------------------------------------------------------

async function initializeReading() {
  try {
    await loadLibrary();
    // The local snapshot also covers a reload before the debounced server save finishes.
    let saved;
    try { saved = JSON.parse(localStorage.getItem('paper-reader.last-reading') || 'null'); } catch { /* Ignore damaged preferences. */ }
    const paper = state.papers.find((item) => item.id === saved?.id)
      || [...state.papers].filter((item) => item.lastOpenedAt).sort((a, b) => Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt))[0];
    if (paper) await selectPaper({ ...paper, currentPage: paper.id === saved?.id ? saved.page : paper.currentPage });
  } catch (error) { showToast(`閱讀位置還原失敗：${error.message}`); }
  finally { pollJobs(); }
}

async function setZoom(value, pointer) {
  if (!state.pdf) return;
  const pdf = state.pdf; const loadId = state.documentLoadId;
  const zoom = Math.min(4, Math.max(.15, value));
  if (Math.abs(zoom - state.zoom) < .001) return;
  const stage = $('readerStage');
  const bounds = stage.getBoundingClientRect();
  const x = pointer?.x ?? bounds.left + stage.clientWidth / 2;
  const y = pointer?.y ?? bounds.top + Math.min(80, stage.clientHeight / 2);
  const pages = [...$('pdfPages').children];
  const anchor = pages.find((page) => page.getBoundingClientRect().bottom >= y) || pages.at(-1);
  if (!anchor) return;
  const rect = anchor.getBoundingClientRect();
  const pageNumber = Number(anchor.dataset.page);
  const fractionX = (x - rect.left) / rect.width;
  const fractionY = (y - rect.top) / rect.height;
  state.zoom = zoom;
  const generation = ++state.zoomGeneration;
  try { localStorage.setItem(`paper-reader.zoom.${state.selectedPaper.id}`, String(zoom)); } catch { /* Zoom remains in memory. */ }
  await renderDocument();
  if (generation !== state.zoomGeneration || state.pdf !== pdf || state.documentLoadId !== loadId) return;
  const next = $('pdfPages').children[pageNumber - 1]?.getBoundingClientRect();
  if (!next) return;
  // Reposition both scroll axes so the same PDF point stays underneath the cursor.
  stage.scrollLeft += next.left + fractionX * next.width - x;
  stage.scrollTop += next.top + fractionY * next.height - y;
  updateCurrentPageFromScroll();
}

async function fitPdf(mode) {
  const pdf = state.pdf;
  if (!pdf) return;
  const viewport = (await pdf.getPage(state.page)).getViewport({ scale: 1.35 });
  if (pdf !== state.pdf) return;
  const stage = $('readerStage');
  const styles = getComputedStyle(stage);
  const width = stage.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight) - 2;
  const height = stage.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom) - 2;
  const zoom = mode === 'page' ? Math.min(width / viewport.width, height / viewport.height) : width / viewport.width;
  const page = state.page;
  await setZoom(zoom);
  if (state.pdf === pdf) { stage.scrollLeft = 0; scrollToPage(page); }
}

function resetSearchResults() {
  ++state.searchGeneration;
  state.searchFocusGeneration = (state.searchFocusGeneration || 0) + 1;
  state.searchMatches = [];
  state.searchIndex = -1;
  $('pdfSearchCount').textContent = '第 0 / 0 筆';
  for (const page of $('pdfPages').children) page.querySelector('.search-layer')?.remove();
}

function closePdfSearch() {
  window.clearTimeout(state.searchTimer);
  $('pdfSearchBar').hidden = true;
  resetSearchResults();
}

async function runPdfSearch() {
  window.clearTimeout(state.searchTimer);
  resetSearchResults();
  const generation = state.searchGeneration;
  const pdf = state.pdf;
  const query = $('pdfSearchInput').value.trim();
  if (!pdf || !query || $('pdfSearchBar').hidden) return;
  $('pdfSearchCount').textContent = '搜尋中…';
  let cache = state.searchText.get(pdf);
  if (!cache) { cache = new Map(); state.searchText.set(pdf, cache); }
  const results = [];
  try {
    for (let page = 1; page <= pdf.numPages; page++) {
      if (generation !== state.searchGeneration || pdf !== state.pdf) return;
      if (!cache.has(page)) cache.set(page, (await (await pdf.getPage(page)).getTextContent()).items);
      for (const match of findTextMatches(cache.get(page), query).matches) results.push({ ...match, page });
    }
    if (generation !== state.searchGeneration || pdf !== state.pdf) return;
    state.searchMatches = results;
    state.searchIndex = results.length ? 0 : -1;
    await focusSearchMatch();
  } catch (error) {
    if (generation === state.searchGeneration) { $('pdfSearchCount').textContent = '搜尋失敗'; showToast(error.message); }
  }
}

async function focusSearchMatch() {
  const generation = state.searchGeneration;
  const focusGeneration = ++state.searchFocusGeneration;
  const match = state.searchMatches[state.searchIndex];
  $('pdfSearchCount').textContent = `第 ${match ? state.searchIndex + 1 : 0} / ${state.searchMatches.length} 筆`;
  if (match) {
    scrollToPage(match.page);
    await ensurePageRendered($('pdfPages').children[match.page - 1]);
    if (generation !== state.searchGeneration || focusGeneration !== state.searchFocusGeneration) return;
  }
  for (const page of $('pdfPages').children) if (page.searchSpans) renderSearchHighlights(page);
  if (match) {
    const mark = $('pdfPages').querySelector('.search-current');
    if (mark) {
      const stage = $('readerStage');
      const bounds = stage.getBoundingClientRect(); const rect = mark.getBoundingClientRect();
      stage.scrollTop += rect.top - bounds.top - stage.clientHeight / 3;
      if (rect.left < bounds.left || rect.right > bounds.right) stage.scrollLeft += rect.left - bounds.left - stage.clientWidth / 3;
    }
  }
}

function renderSearchHighlights(page) {
  page.querySelector('.search-layer')?.remove();
  if (!page.searchSpans || $('pdfSearchBar').hidden) return;
  const layer = Object.assign(document.createElement('div'), { className: 'search-layer' });
  const pageRect = page.getBoundingClientRect();
  state.searchMatches.forEach((match, index) => {
    if (match.page !== Number(page.dataset.page)) return;
    for (const span of page.searchSpans) {
      if (span.end <= match.start || span.start >= match.end || !span.node?.firstChild) continue;
      // Range rectangles preserve line breaks and font transforms without modifying PDF text spans.
      const range = document.createRange();
      range.setStart(span.node.firstChild, Math.max(0, match.start - span.start));
      range.setEnd(span.node.firstChild, Math.min(span.end - span.start, match.end - span.start));
      for (const rect of range.getClientRects()) {
        if (!rect.width || !rect.height) continue;
        const mark = Object.assign(document.createElement('div'), { className: `search-hit${index === state.searchIndex ? ' search-current' : ''}` });
        Object.assign(mark.style, { left: `${rect.left - pageRect.left}px`, top: `${rect.top - pageRect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        layer.append(mark);
      }
    }
  });
  page.append(layer);
}

function stepSearch(delta) {
  if (!state.searchMatches.length) return;
  state.searchIndex = (state.searchIndex + delta + state.searchMatches.length) % state.searchMatches.length;
  focusSearchMatch();
}

async function copyMarkdown(text, ownerDocument) {
  // Use the owning window's clipboard when the assistant is detached; retain a local fallback.
  try { await ownerDocument.defaultView.navigator.clipboard.writeText(text); return; } catch { /* Older/local browser fallback below. */ }
  const input = Object.assign(ownerDocument.createElement('textarea'), { value: text });
  input.style.position = 'fixed'; input.style.opacity = '0';
  ownerDocument.body.append(input); input.select();
  const copied = ownerDocument.execCommand('copy'); input.remove();
  if (!copied) throw new Error('瀏覽器未允許存取剪貼簿');
}

function downloadMarkdown(kind, markdown) {
  const title = state.selectedPaper.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100);
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: `${title}-${kind}.md` });
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('librarySearch').addEventListener('input', renderLibrary);
$('fitWidth').addEventListener('click', () => fitPdf('width'));
$('fitPage').addEventListener('click', () => fitPdf('page'));
$('stopAnswer').addEventListener('click', () => state.answerController?.abort());
$('exportChat').addEventListener('click', () => {
  if (!state.selectedPaper) return showToast('請先選擇一篇論文');
  const messages = [...$('chatMessages').querySelectorAll('.message')].map((message) => ({
    role: message.classList.contains('assistant') ? 'assistant' : 'user',
    content: message.querySelector('.markdown')?.dataset.answer ?? message.querySelector('pre')?.dataset.source ?? '',
  }));
  downloadMarkdown('對話', chatMarkdown(state.selectedPaper.title, messages));
});
$('exportNotes').addEventListener('click', () => {
  if (!state.selectedPaper) return showToast('請先選擇一篇論文');
  downloadMarkdown('筆記', notesMarkdown(state.selectedPaper.title, [...state.annotations].sort((a, b) => a.page - b.page)));
});
$('shortcutsButton').addEventListener('click', () => $('shortcutsDialog').showModal());
$('pdfSearchInput').addEventListener('input', () => {
  // Invalidate immediately so an older scan cannot jump while the user is still typing.
  resetSearchResults(); window.clearTimeout(state.searchTimer);
  state.searchTimer = window.setTimeout(runPdfSearch, 180);
});
$('pdfSearchInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); stepSearch(event.shiftKey ? -1 : 1); }
});
$('pdfSearchBar').addEventListener('submit', (event) => { event.preventDefault(); stepSearch(1); });
$('searchPrevious').addEventListener('click', () => stepSearch(-1));
$('searchClose').addEventListener('click', closePdfSearch);
$('readerStage').addEventListener('wheel', (event) => {
  if (!event.ctrlKey || !state.pdf) return;
  event.preventDefault();
  setZoom(state.zoom * Math.exp(-event.deltaY * .002), { x: event.clientX, y: event.clientY });
}, { passive: false });

// Ignore text inputs, IME composition and modal tours when using navigation shortcuts.
document.addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (!$('settingsView').hidden || !$('tourOverlay').hidden || document.querySelector('dialog[open]')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    $('pdfSearchBar').hidden = false;
    $('pdfSearchInput').focus(); $('pdfSearchInput').select();
    if (state.pdf && $('pdfSearchInput').value) runPdfSearch();
    return;
  }
  if (event.key === 'Escape') {
    closePdfSearch(); closeHighlightPopover();
    if (state.cropMode) setCropMode(false);
    if (event.target === $('pdfSearchInput')) event.target.blur();
    return;
  }
  if (event.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === '?') { event.preventDefault(); $('shortcutsDialog').showModal(); return; }
  if (!state.pdf) return;
  const target = { ArrowLeft: state.page - 1, PageUp: state.page - 1, ArrowRight: state.page + 1, PageDown: state.page + 1, Home: 1, End: state.pdf.numPages }[event.key];
  if (target !== undefined) { event.preventDefault(); scrollToPage(target); }
});
// keepalive submits the last page even when the tab closes before its debounce expires.
window.addEventListener('pagehide', flushReadingPosition);
