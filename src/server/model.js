import { getAppSettings } from './settings.js';
import { runCodexTranslation } from './codex.js';
import { runClaudeTranslation } from './claude.js';

function chatEndpoint(baseUrl) {
  const normalized = String(baseUrl ?? '').replace(/\/+$/, '');
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item) => item?.text ?? '').join('');
  return '';
}

export async function translationSettings() {
  const settings = await getAppSettings();
  return settings.translation;
}

export async function translateText({ text, sourceLanguage, targetLanguage, provider }, { codex = runCodexTranslation, claude = runClaudeTranslation } = {}) {
  const settings = await translationSettings();
  // Translation is always Taiwanese Traditional Chinese, regardless of the selected backend.
  const prompt = `請將以下學術文字翻譯為繁體中文，使用台灣用語。只輸出譯文，保留公式、術語及段落。\n來源語言：${sourceLanguage || '自動辨識'}\n\n${text}`;
  if ((provider || settings.provider) === 'codex') return codex(prompt);
  // The subscription bridge does not use the OpenAI-compatible endpoint or its API key.
  if ((provider || settings.provider) === 'claude') return claude(prompt, { model: settings.claudeModel });
  if (!settings.baseUrl || !settings.model) {
    throw new Error('請配置 TRANSLATION_BASE_URL 和 TRANSLATION_MODEL');
  }

  const headers = { 'content-type': 'application/json' };
  if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
  const response = await fetch(chatEndpoint(settings.baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: '你是學術論文翻譯助手。請用繁體中文與台灣用語，只輸出譯文，保留公式、術語和段落結構，不新增解釋。',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `翻譯模型請求失敗：HTTP ${response.status}`);
  }
  const result = contentText(payload?.choices?.[0]?.message?.content).trim();
  if (!result) throw new Error('翻譯模型返回空結果');
  return result;
}
