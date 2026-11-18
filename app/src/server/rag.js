import { readFile, writeFile } from 'node:fs/promises';
import { getAppSettings } from './settings.js';
import { paperRagIndexPath } from './store.js';
import { parsePdf } from './file-parser.js';

const EMBEDDING_BATCH_SIZE = 64;
const MAX_EMBEDDING_TOKENS = 2800;
const MAX_EMBEDDING_CHARS = 4000;

function joinUrl(baseUrl, pathname) {
  return `${baseUrl.replace(/\/+$/, '')}/${pathname.replace(/^\/+/, '')}`;
}

function authorizationHeader(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

async function postJson(url, body, headers, label, signal) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    const cause = error.cause?.code || error.message;
    throw new Error(`${label}服務連線失敗：${url}（${cause}）`);
  }
  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { raw };
  }
  if (!response.ok) {
    const detail = payload.error?.message || payload.error || payload.raw || raw;
    throw new Error(`${label}請求失敗：HTTP ${response.status}${detail ? `，${detail}` : ''}`);
  }
  return payload;
}

function headingLine(line) {
  const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
  return match ? { level: match[1].length, title: match[2] } : null;
}

function htmlTableToMarkdown(html) {
  const rows = [];
  for (const rowMatch of String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((cell) => cell[1].replace(/<[^>]*>/g, '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim());
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return html;
  const width = Math.max(...rows.map((row) => row.length));
  const lines = rows.map((row) => `| ${[...row, ...Array(width - row.length).fill('')].join(' | ')} |`);
  lines.splice(1, 0, `| ${Array(width).fill('---').join(' | ')} |`);
  return lines.join('\n');
}

function convertHtmlTables(markdown) {
  return markdown.replace(/<table[\s\S]*?<\/table>/gi, (table) => htmlTableToMarkdown(table));
}

function hasContent(lines) {
  return lines.some((line) => line.trim());
}

function renderSection(title, level, lines, parentTitle = null) {
  const headings = [`## ${parentTitle ?? title}`];
  if (parentTitle) headings.push(`### ${title}`);
  const body = lines.join('\n').trim();
  return {
    title: parentTitle ? `${parentTitle} / ${title}` : title,
    parentTitle,
    level,
    text: `${headings.join('\n')}\n\n${body}`.trim(),
  };
}

function flushChapter(sections, chapter) {
  if (!chapter) return;
  if (chapter.level === 3) {
    if (hasContent(chapter.lines)) sections.push(renderSection(chapter.title, 3, chapter.lines, chapter.parentTitle));
    return;
  }
  if (hasContent(chapter.lines)) sections.push(renderSection(chapter.title, 2, chapter.lines));
}

/**
 * Convert Expert Markdown into section units.
 * H1 is ignored. H2 owns direct text, while H3 is the smallest section unit
 * and carries its H2 title in both metadata and embedded text.
 */
export function buildSectionsFromMarkdown(markdown) {
  const sections = [];
  let currentH2 = null;
  let current = null;
  let inFence = false;

  for (const line of convertHtmlTables(String(markdown ?? '')).split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (current) current.lines.push(line);
      continue;
    }
    const heading = inFence ? null : headingLine(line);
    if (!heading) {
      if (current) current.lines.push(line);
      continue;
    }
    if (heading.level === 1) continue;
    if (heading.level === 2) {
      flushChapter(sections, current);
      currentH2 = heading.title;
      current = { level: 2, title: currentH2, lines: [] };
      continue;
    }
    if (!currentH2) continue;
    if (current?.level === 2) {
      flushChapter(sections, current);
    } else {
      flushChapter(sections, current);
    }
    current = { level: 3, title: heading.title, parentTitle: currentH2, lines: [] };
  }
  flushChapter(sections, current);
  return sections.map((section, index) => ({
    id: `section-${index + 1}`,
    ...section,
    pageStart: null,
    pageEnd: null,
  }));
}

// MinerU may use H1 for chapters and H2 for numbered subsections.
export function normalizeMineruMarkdown(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const output = [];
  let inFence = false;
  let hasHeading = false;
  let currentChapter = null;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = inFence ? null : headingLine(line);
    if (!heading) {
      if (!hasHeading && line.trim()) { output.push('## Preamble'); hasHeading = true; }
      output.push(line);
      continue;
    }
    const number = /^(\d+(?:\.\d+)*)\b/.exec(heading.title)?.[1];
    const isSubsection = heading.level >= 3 || (heading.level === 2 && number?.includes('.') && currentChapter);
    if (isSubsection && currentChapter) output.push(`### ${heading.title}`);
    else {
      output.push(`## ${heading.title}`);
      currentChapter = heading.title;
    }
    hasHeading = true;
  }
  return output.join('\n');
}

// Character bigrams allow Chinese queries to match text without a dictionary.
export function tokenizeBm25(text) {
  const tokens = [];
  for (const match of String(text).toLowerCase().matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu)) {
    const word = match[0];
    if (/^\p{Script=Han}+$/u.test(word)) {
      const chars = [...word];
      tokens.push(...chars);
      for (let index = 0; index < chars.length - 1; index += 1) tokens.push(chars[index] + chars[index + 1]);
    } else tokens.push(word);
  }
  return tokens;
}

export function rankSectionsBm25(sections, query) {
  const documents = sections.map((section) => tokenizeBm25(section.text));
  const terms = [...new Set(tokenizeBm25(query))];
  const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / (documents.length || 1);
  const frequencies = terms.map((term) => documents.reduce((count, doc) => count + Number(doc.includes(term)), 0));
  return sections.map((section, index) => {
    const doc = documents[index];
    let score = 0;
    terms.forEach((term, termIndex) => {
      const frequency = doc.reduce((sum, token) => sum + Number(token === term), 0);
      if (!frequency) return;
      const idf = Math.log(1 + (documents.length - frequencies[termIndex] + 0.5) / (frequencies[termIndex] + 0.5));
      score += idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * doc.length / (averageLength || 1)));
    });
    return { title: section.title, parentTitle: section.parentTitle, pageStart: section.pageStart, pageEnd: section.pageEnd, text: section.text, score };
  }).sort((left, right) => right.score - left.score);
}

function estimateTokens(text) {
  const value = String(text);
  const nonAscii = (value.match(/[^\x00-\x7F]/g) || []).length;
  return nonAscii + Math.ceil((value.length - nonAscii) / 4);
}

function exceedsEmbeddingLimit(text) {
  return text.length > MAX_EMBEDDING_CHARS || estimateTokens(text) > MAX_EMBEDDING_TOKENS;
}

function splitSection(section) {
  const prefix = section.text.split(/\n\n/, 1)[0];
  const body = section.text.slice(prefix.length).trim();
  if (!body) return [section];
  const paragraphs = body.split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean);
  const parts = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (current && exceedsEmbeddingLimit(`${prefix}\n\n${candidate}`)) {
      parts.push(`${prefix}\n\n${current}`);
      current = paragraph;
    } else {
      current = candidate;
    }
    if (exceedsEmbeddingLimit(`${prefix}\n\n${current}`)) {
      throw new Error(`章節內容超過 Embedding-3 單條限制，無法按段落切分：${section.title}`);
    }
  }
  if (current) parts.push(`${prefix}\n\n${current}`);
  return parts.map((text, index) => ({
    ...section,
    id: `${section.id}-${index + 1}`,
    text,
    part: index + 1,
    partCount: parts.length,
  }));
}

export function splitSectionsForEmbedding(sections) {
  return sections.flatMap(splitSection);
}

async function embedTexts(texts, settings, signal) {
  if (!settings.rag.embeddingBaseUrl) throw new Error('未配置智譜 embedding 服務地址');
  if (!settings.rag.embeddingApiKey) throw new Error('未配置智譜 API key（GLM_API_KEY）');
  if (!texts.length) return [];
  const vectors = [];
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const input = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
    const payload = await postJson(
      joinUrl(settings.rag.embeddingBaseUrl, '/embeddings'),
      { model: settings.rag.embeddingModel, input, dimensions: settings.rag.embeddingDimensions },
      authorizationHeader(settings.rag.embeddingApiKey),
      '智譜 Embedding-3',
      signal,
    );
    const data = Array.isArray(payload.data) ? [...payload.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];
    if (data.length !== input.length || data.some((item) => !Array.isArray(item.embedding))) {
      throw new Error('智譜 Embedding-3 返回的向量數量或格式不正確');
    }
    vectors.push(...data.map((item) => item.embedding.map(Number)));
  }
  if (vectors.some((vector) => !vector.length || vector.some((value) => !Number.isFinite(value)))) {
    throw new Error('智譜 Embedding-3 返回了無效向量');
  }
  return vectors;
}

function normalizeVector(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm) throw new Error('智譜 Embedding-3 返回了零向量');
  return vector.map((value) => value / norm);
}

function cosineSimilarity(left, right) {
  if (left.length !== right.length) throw new Error('embedding 維度不一致');
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

export async function buildPaperRagIndex(pdfBuffer, paperDirectory, options = {}) {
  const settings = options.settings ?? await getAppSettings();
  const parsed = await parsePdf(pdfBuffer, paperDirectory, settings, options.signal);
  const isMineru = settings.rag?.parserProvider !== 'zhipu';
  const sections = buildSectionsFromMarkdown(isMineru ? normalizeMineruMarkdown(parsed.markdown) : parsed.markdown);
  if (!sections.length) throw new Error('Parser returned no sections');
  const useEmbedding = settings.rag?.retrievalProvider === 'embedding' && Boolean(settings.rag?.embeddingApiKey);
  // BM25 accepts long paragraphs without imposing an embedding provider limit.
  const chunks = useEmbedding ? splitSectionsForEmbedding(sections) : sections;
  const embeddings = useEmbedding ? await embedTexts(chunks.map((section) => section.text), settings, options.signal) : null;
  return {
    version: 3,
    parser: isMineru ? 'mineru' : 'zhipu-expert',
    retrievalProvider: useEmbedding ? 'embedding' : 'bm25',
    ...(useEmbedding ? { embeddingModel: settings.rag.embeddingModel, embeddingDimensions: settings.rag.embeddingDimensions } : {}),
    ...(parsed.sha256 ? { sha256: parsed.sha256 } : {}),
    sections: chunks.map((section, index) => embeddings ? { ...section, embedding: normalizeVector(embeddings[index]) } : section),
    images: parsed.images,
    indexedAt: new Date().toISOString(),
  };
}

export async function savePaperRagIndex(paperId, index) {
  await writeFile(paperRagIndexPath(paperId), JSON.stringify(index));
}

async function readPaperRagIndex(paperId) {
  try {
    return JSON.parse(await readFile(paperRagIndexPath(paperId), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('論文全文索引不存在，請重新匯入論文');
    throw error;
  }
}

export async function retrievePaperSections(paperId, query, topK, signal) {
  const text = String(query ?? '').trim();
  if (!text) throw new Error('全文檢索問題不能為空');
  const settings = await getAppSettings();
  const limit = Number(topK ?? settings.rag.topK);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('全文檢索 topK 必須是正整數');
  const index = await readPaperRagIndex(paperId);
  const useEmbedding = settings.rag?.retrievalProvider === 'embedding'
    && Boolean(settings.rag?.embeddingApiKey)
    && index.sections.every((section) => Array.isArray(section.embedding));
  if (!useEmbedding) return rankSectionsBm25(index.sections, text).slice(0, limit);
  const queryEmbedding = await embedTexts([text], settings, signal);
  const queryVector = normalizeVector(queryEmbedding[0]);
  return index.sections
    .map((section) => ({
      title: section.title,
      parentTitle: section.parentTitle,
      pageStart: section.pageStart,
      pageEnd: section.pageEnd,
      text: section.text,
      score: cosineSimilarity(queryVector, section.embedding),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export { cosineSimilarity, normalizeVector };
