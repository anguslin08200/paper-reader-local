import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('selection translation dispatches Claude separately while keeping Ollama and Codex intact', async () => {
  // Inject model transports: this test must never call an authenticated CLI or the network.
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'paper-model-'));
  const previousRuntime = process.env.PAPER_READER_RUNTIME_DIR;
  const originalFetch = globalThis.fetch;
  process.env.PAPER_READER_RUNTIME_DIR = runtime;
  try {
    const { saveAppSettings } = await import('../src/server/settings.js');
    const { translateText } = await import('../src/server/model.js');
    await saveAppSettings({ translation: { provider: 'claude', claudeModel: 'haiku', apiKey: 'must-not-forward' } });
    const input = { text: 'Selective state space models.', sourceLanguage: 'auto' };
    let captured;
    const transports = {
      claude: async (prompt, options) => { captured = { prompt, options }; return '選擇性狀態空間模型。'; },
      codex: async (prompt) => { captured = { prompt }; return 'Codex 測試譯文'; },
    };
    assert.equal(await translateText(input, transports), '選擇性狀態空間模型。');
    assert.match(captured.prompt, /繁體中文.*台灣用語/);
    assert.deepEqual(captured.options, { model: 'haiku' });
    assert.equal(await translateText({ ...input, provider: 'codex' }, transports), 'Codex 測試譯文');
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:11434/v1/chat/completions');
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, 'hf.co/tencent/Hy-MT2-7B-GGUF:Q4_K_M');
      return { ok: true, json: async () => ({ choices: [{ message: { content: '本機測試譯文' } }] }) };
    };
    assert.equal(await translateText({ ...input, provider: 'ollama' }, transports), '本機測試譯文');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousRuntime === undefined) delete process.env.PAPER_READER_RUNTIME_DIR;
    else process.env.PAPER_READER_RUNTIME_DIR = previousRuntime;
    await rm(runtime, { recursive: true, force: true });
  }
});
