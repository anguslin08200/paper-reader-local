import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeDirectory } from './runtime.js';
import { mineruConfig } from './mineru-config.js';
import { normalizeExportDirectory } from './annotation-save.js';
import { ANSWER_DETAIL_DEFAULTS } from './answer-detail.js';

const settingsPath = path.join(runtimeDirectory, 'settings.json');
const promptDirectory = path.join(runtimeDirectory, 'prompt-templates');

// Local tools are the defaults; paid services require an explicit provider selection.
const defaultSettings = {
  translation: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'hf.co/tencent/Hy-MT2-7B-GGUF:Q4_K_M', claudeModel: 'sonnet' },
  rag: {
    parserProvider: 'mineru',
    retrievalProvider: 'bm25',
    mineruExecutable: '',
    mineruHome: '',
    mineruCacheDirectory: '',
    parserBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    parserApiKey: '',
    embeddingBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    embeddingApiKey: '',
    embeddingModel: 'embedding-3',
    embeddingDimensions: 2048,
    topK: 5,
  },
  // Medium effort: low produced noticeably shallow paper explanations.
  // claudeEffort '' = Claude CLI default; otherwise low/medium/high/xhigh/max.
  agent: { provider: 'codex', model: '', thinking: 'medium', claudeModel: 'sonnet', claudeEffort: '' },
  pdfTranslation: {
    provider: 'Codex',
    // Bundled bridge (pdf-translate/); its Python env comes from setup.ps1 -Translate.
    scriptPath: fileURLToPath(new URL('../../pdf-translate/Translate-PDF.ps1', import.meta.url)),
    effort: 'low', parallel: 8, model: '',
  },
  prompts: {
    // Editable answer depth and example instructions supplement task templates.
    ...ANSWER_DETAIL_DEFAULTS,
    // Shared editable template for comparison requests.
    compare: '請先依附件編號逐項說明內容與重點，再比較彼此的異同、關聯，以及各自在論文中的角色；請引用附件編號、頁碼與原文依據。',
    summary: '請概括這篇論文的研究問題、方法、主要結果和侷限。',
    section: '請精讀目前頁對應的章節，解釋關鍵概念、論證邏輯和與全文的關係。',
    figure: '請解釋這張圖：先說明它要回答的問題，再逐一說明座標軸、圖例或方塊／箭頭等元素的意義，指出關鍵趨勢或流程，最後說明它支援論文的哪個結論。若有附上論文原文或圖說，以原文為準。',
    question: '請基於論文上下文回答使用者問題，並給出可核對的頁碼或原文依據。',
    // Element-specific templates used by the figure list and crop quick actions.
    table: '請解讀這張表：說明比較的對象與指標，挑出最重要的數字與差距（附數值），說明作者想用它證明什麼，並指出需要注意的比較條件。',
    algorithm: '請逐步詳細解釋這個演算法。務必先在 parsed/result.md 找到對應的演算法原文（例如 Algorithm 1 區塊）再解釋：\n1. 目的、輸入與輸出\n2. 依行號或 Step 標籤逐步說明每一步在做什麼、為什麼要這樣做\n3. 列出變數與符號表（符號、意義、維度或大小）\n4. 用一個小的數值例子走一遍關鍵步驟\n5. 計算複雜度或硬體上的意義\n6. 與論文中的圖、公式、章節的對應關係',
    equation: '請解釋這個公式：列出符號表（每個符號的意義與單位／維度），說明公式的直覺與推導來源，用一個小數值例子代入計算，並說明它在論文方法中的角色與前後文關係。',
    example: '請用一個具體、簡化的小例子（含數值）說明這個內容是怎麼運作的，一步一步走完，最後總結例子對應到論文的哪個概念。',
    // Text selection templates: a highlighted passage or a single term.
    passage: '請解釋使用者選取的這段文字：先用白話說明它在說什麼，再拆解其中的關鍵概念與論證，說明它在論文中的上下文（屬於哪一節、前後在談什麼），必要時補充背景知識。',
    term: '請解釋使用者選取的這個名詞：給出簡潔定義，說明它在這篇論文中的具體意思與用法（引用出現的章節），必要時補充背景知識與相關名詞，並舉一個簡單例子。',
  },
};

export function mergeSettings(saved = {}) {
  // Environment overrides and configured paths use the same resolution as the parser.
  const mineru = mineruConfig(saved.rag);
  return {
    // Export location is independent of the original PDFs and runtime library.
    exportDirectory: normalizeExportDirectory(saved.exportDirectory),
    translation: {
      // Keep subscription model aliases separate from the Ollama and Codex model names.
      claudeModel: saved.translation?.claudeModel?.trim() || defaultSettings.translation.claudeModel,
      provider: saved.translation?.provider ?? defaultSettings.translation.provider,
      // Migrate the original app's empty translation fields to usable local defaults.
      baseUrl: saved.translation?.baseUrl || process.env.TRANSLATION_BASE_URL || defaultSettings.translation.baseUrl,
      apiKey: saved.translation?.apiKey ?? process.env.TRANSLATION_API_KEY ?? defaultSettings.translation.apiKey,
      model: saved.translation?.model || process.env.TRANSLATION_MODEL || defaultSettings.translation.model,
    },
    rag: {
      parserProvider: saved.rag?.parserProvider ?? defaultSettings.rag.parserProvider,
      retrievalProvider: saved.rag?.retrievalProvider ?? defaultSettings.rag.retrievalProvider,
      mineruExecutable: mineru.executable,
      mineruHome: mineru.home,
      mineruCacheDirectory: mineru.cacheDirectory,
      parserBaseUrl: saved.rag?.parserBaseUrl ?? process.env.GLM_PARSER_BASE_URL ?? defaultSettings.rag.parserBaseUrl,
      parserApiKey: saved.rag?.parserApiKey ?? process.env.GLM_API_KEY ?? defaultSettings.rag.parserApiKey,
      embeddingBaseUrl: saved.rag?.embeddingBaseUrl ?? process.env.GLM_EMBEDDING_BASE_URL ?? defaultSettings.rag.embeddingBaseUrl,
      embeddingApiKey: saved.rag?.embeddingApiKey ?? process.env.GLM_API_KEY ?? defaultSettings.rag.embeddingApiKey,
      embeddingModel: saved.rag?.embeddingModel ?? process.env.GLM_EMBEDDING_MODEL ?? defaultSettings.rag.embeddingModel,
      embeddingDimensions: Number(saved.rag?.embeddingDimensions ?? process.env.GLM_EMBEDDING_DIMENSIONS ?? defaultSettings.rag.embeddingDimensions),
      topK: Number(saved.rag?.topK ?? process.env.RAG_TOP_K ?? defaultSettings.rag.topK),
    },
    agent: {
      claudeModel: saved.agent?.claudeModel?.trim() || defaultSettings.agent.claudeModel,
      claudeEffort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(saved.agent?.claudeEffort) ? saved.agent.claudeEffort : defaultSettings.agent.claudeEffort,
      provider: saved.agent?.provider ?? defaultSettings.agent.provider,
      model: saved.agent?.model ?? ((saved.agent?.provider === 'pi' ? process.env.PI_MODEL : process.env.PAPER_READER_CODEX_MODEL) ?? defaultSettings.agent.model),
      thinking: saved.agent?.thinking ?? ((saved.agent?.provider === 'pi' ? process.env.PI_THINKING : process.env.PAPER_READER_CODEX_EFFORT) ?? defaultSettings.agent.thinking),
    },
    pdfTranslation: { ...defaultSettings.pdfTranslation, ...(saved.pdfTranslation ?? {}) },
    // Joke question shown on every launch (on by default) until answered 否 with 「不再顯示」 checked.
    startupQuestion: saved.startupQuestion !== false,
    prompts: migratePrompts({ ...defaultSettings.prompts, ...(saved.prompts ?? {}) }),
  };
}

// Earlier built-in defaults that users never edited are upgraded; customized text is kept.
const LEGACY_PROMPTS = {
  figure: ['請解釋目前圖片或表格，說明圖中元素、資料趨勢以及它支援的論文結論。', '请解释当前图片或表格，说明图中元素、数据趋势以及它支持的论文结论。'],
};
function migratePrompts(prompts) {
  for (const [name, legacy] of Object.entries(LEGACY_PROMPTS)) {
    if (legacy.includes(prompts[name]?.trim())) prompts[name] = defaultSettings.prompts[name];
  }
  return prompts;
}

export async function getAppSettings() {
  await mkdir(runtimeDirectory, { recursive: true });
  try {
    return mergeSettings(JSON.parse(await readFile(settingsPath, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return mergeSettings();
  }
}

export async function saveAppSettings(patch) {
  const current = await getAppSettings();
  const next = mergeSettings({
    ...current,
    exportDirectory: patch.exportDirectory ?? current.exportDirectory,
    translation: { ...current.translation, ...(patch.translation ?? {}) },
    rag: { ...current.rag, ...(patch.rag ?? {}) },
    agent: { ...current.agent, ...(patch.agent ?? {}) },
    pdfTranslation: { ...current.pdfTranslation, ...(patch.pdfTranslation ?? {}) },
    startupQuestion: typeof patch.startupQuestion === 'boolean' ? patch.startupQuestion : current.startupQuestion,
    prompts: { ...current.prompts, ...(patch.prompts ?? {}) },
  });
  // Concurrent requests must never read a truncated settings document.
  const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(next, null, 2));
  await rename(temporaryPath, settingsPath);
  return next;
}

export function publicSettings(settings) {
  settings = mergeSettings(settings);
  const rag = settings.rag ?? defaultSettings.rag;
  return {
    exportDirectory: settings.exportDirectory,
    translation: {
      claudeModel: settings.translation.claudeModel,
      provider: settings.translation.provider,
      baseUrl: settings.translation.baseUrl,
      model: settings.translation.model,
      apiKeyConfigured: Boolean(settings.translation.apiKey),
    },
    rag: {
      parserProvider: rag.parserProvider,
      retrievalProvider: rag.retrievalProvider,
      mineruExecutable: rag.mineruExecutable,
      mineruHome: rag.mineruHome,
      mineruCacheDirectory: rag.mineruCacheDirectory,
      parserBaseUrl: rag.parserBaseUrl,
      embeddingBaseUrl: rag.embeddingBaseUrl,
      embeddingModel: rag.embeddingModel,
      embeddingDimensions: rag.embeddingDimensions,
      topK: rag.topK,
      parserApiKeyConfigured: Boolean(rag.parserApiKey),
      embeddingApiKeyConfigured: Boolean(rag.embeddingApiKey),
    },
    agent: settings.agent,
    pdfTranslation: settings.pdfTranslation,
    startupQuestion: settings.startupQuestion,
    prompts: settings.prompts,
  };
}

export async function writePromptTemplates(settings, directory = promptDirectory) {
  // Tests supply a temporary directory instead of touching the user's templates.
  await mkdir(directory, { recursive: true });
  // Every task template (including element-specific ones) is materialized for the Pi provider.
  const templates = Object.fromEntries(PROMPT_TASKS.map((name) => [name, settings.prompts[name]]));
  for (const [name, instruction] of Object.entries(templates)) {
    const content = [
      '---',
      `description: Paper Reader ${name} prompt`,
      'argument-hint: "[paper context]"',
      '---',
      instruction,
      '',
      '$@',
      '',
    ].join('\n');
    await writeFile(path.join(directory, `paper-${name}.md`), content);
  }
  return directory;
}

export { promptDirectory };

// Single source of truth for assistant task names shared by all providers.
export const PROMPT_TASKS = ['compare', 'summary', 'section', 'figure', 'question', 'table', 'algorithm', 'equation', 'example', 'passage', 'term'];
