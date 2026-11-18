import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergeSettings, publicSettings, writePromptTemplates } from '../src/server/settings.js';
import { parseMetadataResponse } from '../src/server/pi.js';

test('public settings mask the translation API key', () => {
  const result = publicSettings({
    translation: { baseUrl: 'http://localhost/v1', model: 'translator', apiKey: 'secret' },
    agent: { model: 'reader', thinking: 'high' },
    prompts: { summary: 'summary', section: 'section', figure: 'figure', question: 'question' },
  });
  assert.equal(result.translation.apiKeyConfigured, true);
  assert.equal('apiKey' in result.translation, false);
});

test('public settings expose Zhipu parser and embedding configuration without keys', () => {
  const result = publicSettings({
    translation: { baseUrl: '', model: '', apiKey: '' },
    rag: {
      parserBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      parserApiKey: 'secret',
      embeddingBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      embeddingApiKey: 'secret',
      embeddingModel: 'embedding-3',
      embeddingDimensions: 2048,
      topK: 5,
    },
  });
  assert.equal(result.rag.parserApiKeyConfigured, true);
  assert.equal(result.rag.embeddingApiKeyConfigured, true);
  assert.equal(result.rag.embeddingModel, 'embedding-3');
  assert.equal(result.rag.embeddingDimensions, 2048);
  assert.equal('parserApiKey' in result.rag, false);
  assert.equal('embeddingApiKey' in result.rag, false);
});

test('parses paper metadata JSON returned by pi', () => {
  const result = parseMetadataResponse('```json\n{"title": " Looped Models ", "authors": ["A. Author", ""], "year": 2026}\n```');
  assert.deepEqual(result, { title: 'Looped Models', authors: ['A. Author'], year: '2026' });
  assert.throws(() => parseMetadataResponse('no metadata'), /JSON/);
  assert.throws(() => parseMetadataResponse('{"title": ""}'), /標題/);
});

test('prompt templates expose the configured task instruction and arguments', async () => {
  // Avoid writing or deleting the user's runtime templates during unit checks.
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'paper-prompts-'));
  const directory = await writePromptTemplates({
    prompts: { summary: '自定義概括', section: '自定義精讀', figure: '自定義圖片', question: '自定義問答' },
  }, temporaryDirectory);
  const content = await readFile(`${directory}/paper-summary.md`, 'utf8');
  assert.match(content, /自定義概括/);
  assert.match(content, /\$@/);
  await rm(directory, { recursive: true, force: true });
});

test('local defaults require no paid API keys and expose configurable tools', () => {
  const settings = mergeSettings();
  assert.equal(settings.agent.provider, 'codex');
  assert.equal(settings.agent.thinking, 'medium');
  assert.equal(settings.agent.claudeModel, 'sonnet');
  assert.equal(settings.translation.claudeModel, 'sonnet');
  assert.equal(settings.rag.parserProvider, 'mineru');
  assert.equal(settings.rag.retrievalProvider, 'bm25');
  assert.equal(settings.translation.provider, 'ollama');
  assert.equal(settings.translation.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(settings.translation.model, 'hf.co/tencent/Hy-MT2-7B-GGUF:Q4_K_M');
  assert.equal(settings.pdfTranslation.provider, 'Codex');
  assert.match(settings.rag.mineruExecutable, /mineru-kit\.exe$/);
  assert.equal(mergeSettings({agent:{provider:'pi'}}).agent.provider, 'pi');
  assert.equal(mergeSettings({translation:{baseUrl:'',model:''}}).translation.baseUrl, 'http://127.0.0.1:11434/v1');
});

test('Claude aliases stay separate from Codex and local translation model settings', () => {
  const result = publicSettings(mergeSettings({
    agent: { provider: 'claude', model: 'codex-model', claudeModel: 'opus' },
    translation: { provider: 'claude', claudeModel: 'haiku' },
  }));
  assert.equal(result.agent.claudeModel, 'opus');
  assert.equal(result.agent.model, 'codex-model');
  assert.equal(result.translation.claudeModel, 'haiku');
  assert.equal(result.translation.model, 'hf.co/tencent/Hy-MT2-7B-GGUF:Q4_K_M');
});

// Environment overrides, explicit settings, and portable defaults must agree with parsing.
test('MinerU configuration resolves environment, saved paths, and portable defaults', async () => {
  const { mineruConfig } = await import('../src/server/mineru-config.js');
  const keys = ['MINERU_KIT', 'MINERU_HOME', 'MINERU_CACHE_DIR'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    const defaults = mineruConfig();
    // The project may sit at the repository root or in its app/ folder, so a mineru folder one or
    // two levels up is accepted (the first one that exists, otherwise the nearer one).
    const bases = [path.resolve('..', 'mineru'), path.resolve('..', '..', 'mineru')];
    const base = bases.find((candidate) => defaults.executable === path.join(candidate, '.venv', 'Scripts', 'mineru-kit.exe'));
    assert.ok(base, defaults.executable);
    assert.equal(defaults.home, path.join(base, 'home'));
    assert.equal(defaults.cacheDirectory, '');
    const saved = { mineruExecutable: 'saved-kit', mineruHome: 'saved-home', mineruCacheDirectory: 'saved-cache' };
    assert.deepEqual(mineruConfig(saved), { executable: 'saved-kit', home: 'saved-home', cacheDirectory: 'saved-cache' });
    process.env.MINERU_KIT = 'env-kit'; process.env.MINERU_HOME = 'env-home'; process.env.MINERU_CACHE_DIR = 'env-cache';
    assert.deepEqual(mineruConfig(saved), { executable: 'env-kit', home: 'env-home', cacheDirectory: 'env-cache' });
    const settings = mergeSettings({ rag: saved }).rag;
    assert.deepEqual([settings.mineruExecutable, settings.mineruHome, settings.mineruCacheDirectory], ['env-kit', 'env-home', 'env-cache']);
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
