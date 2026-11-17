const preferenceKey = 'paper-reader.auto-translate';

// Storage may be unavailable in private browser sessions; importing must still work.
function rememberedAutoTranslate() {
  try { return localStorage.getItem(preferenceKey) === 'true'; } catch { return false; }
}

export function confirmImport({ fileName, detect }) {
  const dialog = document.getElementById('importDialog');
  const form = document.getElementById('importOptions');
  const auto = document.getElementById('importAutoTranslate');
  const translated = document.getElementById('importTranslated');
  const variant = document.getElementById('importVariant');
  const submit = document.getElementById('confirmImport');
  const result = document.getElementById('importDetection');
  document.getElementById('importFileName').textContent = fileName;
  result.textContent = '正在檢查檔名與前兩頁文字…';
  form.reset();
  auto.checked = rememberedAutoTranslate();
  // Prevent a late detection result from overwriting choices made while preview is loading.
  const setPending = (pending) => {
    submit.disabled = pending;
    for (const input of form.querySelectorAll('input, select')) input.disabled = pending;
  };
  setPending(true);
  let detection = null;
  let active = true;
  const update = () => {
    document.getElementById('importAutoField').hidden = translated.checked;
    document.getElementById('importVariantField').hidden = !translated.checked;
    document.getElementById('importQualityNote').hidden = !translated.checked;
  };
  update();
  dialog.showModal();
  return new Promise((resolve) => {
    const close = () => {
      active = false;
      form.removeEventListener('submit', accept);
      form.removeEventListener('change', update);
      dialog.removeEventListener('close', close);
      resolve(dialog.returnValue === 'import' ? {
        sourceKind: translated.checked ? 'translated' : 'original',
        translatedVariant: translated.checked ? variant.value : null,
        autoTranslate: !translated.checked && auto.checked,
        previewToken: detection?.previewToken,
      } : null);
    };
    const accept = (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      // Only explicit confirmation updates the preference; translated files never auto-translate.
      if (!translated.checked) {
        try { localStorage.setItem(preferenceKey, String(auto.checked)); } catch { /* Optional preference. */ }
      }
      dialog.close('import');
    };
    dialog.returnValue = '';
    form.addEventListener('submit', accept);
    form.addEventListener('change', update);
    dialog.addEventListener('close', close, { once: true });
    Promise.resolve().then(detect).then((value) => {
      if (!active) return;
      detection = value;
      if (value.fileName) document.getElementById('importFileName').textContent = value.fileName;
      translated.checked = value.sourceKind === 'translated';
      document.getElementById('importOriginal').checked = !translated.checked;
      variant.value = value.translatedVariant || 'bilingual';
      const ratio = Number.isFinite(value.cjkRatio) ? `；前兩頁 CJK 比例 ${Math.round(value.cjkRatio * 100)}%` : '';
      const reason = { filename: '檔名符合譯本命名慣例。', text: '前兩頁中文比例較高。', default: '未發現明顯的譯本標記。' }[value.reason] || '';
      result.textContent = `自動判斷：${translated.checked ? '已翻譯版' : '英文原文'}${ratio}。${reason}可自行修改。`;
      setPending(false);
      update();
    }).catch((error) => {
      if (!active) return;
      // A failed preview is explicit and still permits the user's manual classification.
      result.textContent = `自動識別失敗：${error.message}。請手動選擇檔案類型。`;
      setPending(false);
    });
  });
}
