// Shared defaults keep older settings and all providers consistent.
export const ANSWER_DETAIL_DEFAULTS = {
  detailSimple: '用 3–6 句白話重點說明，避免公式推導與過多術語，必要時用一個類比。',
  detailDetailed: '完整深入說明：背景、逐步推導或逐行說明、符號定義、與論文其他部分的關聯、限制與常見誤解。',
  exampleSimple: '用一個簡短直覺例子說明，僅使用少量數字，幾句話即可。',
  exampleFull: '提供完整數值例子，逐步計算每一步並對照論文符號，最後總結。',
};

// Only known string options can select editable instructions.
export function answerDetailInstructions(detail, exampleLevel, prompts = {}) {
  const detailKey = { simple: 'detailSimple', detailed: 'detailDetailed' };
  const exampleKey = { simple: 'exampleSimple', full: 'exampleFull' };
  const keys = [typeof detail === 'string' && Object.hasOwn(detailKey, detail) ? detailKey[detail] : null,
    typeof exampleLevel === 'string' && Object.hasOwn(exampleKey, exampleLevel) ? exampleKey[exampleLevel] : null];
  return keys.filter(Boolean).map((key) => typeof prompts?.[key] === 'string' && prompts[key].trim()
    ? prompts[key] : ANSWER_DETAIL_DEFAULTS[key]);
}
