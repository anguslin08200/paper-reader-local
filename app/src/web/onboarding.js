const tourKey = 'paper-reader.tour.v1';
const steps = [
  { target: '#importTools', title: '匯入 PDF 或 arXiv', text: '建議上傳英文原文。選擇 PDF 或輸入 arXiv 連結後，確認自動識別結果；已翻譯版會預先選中，也可手動修改。原文可選擇匯入後自動整篇翻譯。' },
  { target: '#libraryTree', title: '文獻庫與右鍵選單', text: '在資料夾中整理和選擇論文。右鍵論文可重新解析、刪除，或標記為已翻譯版／英文原文；舊資料也能直接修正，無需重新匯入。' },
  { target: '.reader-controls', paper: true, title: '閱讀工具欄', text: '選取文字後可畫螢光筆或加註記；點螢光筆可編輯。按 T 可放置文字註記，Ctrl+Z 復原、Ctrl+Y 或 Ctrl+Shift+Z 重做，Ctrl+S 儲存含標註的 PDF。也可用「框選區域」截取任意範圍（Esc 取消）。' },
  { target: '.document-tools', paper: true, title: '解析、翻譯與版本', text: '這裡顯示背景解析與整篇翻譯狀態，可檢視任務詳情、手動重新解析。英文原文可用 PDFMathTranslate 生成中文與雙語 PDF，並切換已有版本；已翻譯版無需再翻譯。' },
  { target: '.right-sidebar', title: '論文助手', text: '頂部顯示目前模型，點一下可切換 Codex／Claude、模型與思考強度。對話有記憶，每篇論文分開保存，重開後仍會延續；「新對話」可清除。「圖表清單」列出所有圖、表、演算法與公式，點選即跳頁並附上原文。' },
  { target: '#settingsButton', title: '設定你的工具', text: '選擇 Codex、Claude 或 Pi 助手，設定選區翻譯服務、PDFMathTranslate 與 MinerU。Codex／Claude 需要先登入；使用訂閱服務會消耗相應帳號額度。' },
  { title: '資料儲存在本機', text: '論文、解析結果和設定儲存在本機 .runtime 目錄。解析只做一次並儲存，後續閱讀會複用；需要時可手動重新解析。使用外部助手或翻譯服務時，相關內容會交給所選服務處理。' },
];

export function initializeTour() {
  const overlay = document.getElementById('tourOverlay');
  const bubble = document.getElementById('tourBubble');
  const next = document.getElementById('tourNext');
  const previous = document.getElementById('tourPrevious');
  const skip = document.getElementById('tourSkip');
  const highlight = document.getElementById('tourHighlight');
  const surfaces = [document.getElementById('appShell'), document.getElementById('settingsView')];
  let index = 0;
  let returnFocus;
  let originalInert;

  function position() {
    if (overlay.hidden) return;
    const step = steps[index];
    const target = step.target && document.querySelector(step.target);
    const rect = target?.getBoundingClientRect();
    // Missing, hidden or offscreen targets use a centered explanation instead of failing.
    const visible = rect && rect.width > 0 && rect.height > 0 && rect.left < innerWidth && rect.top < innerHeight
      && rect.right > 0 && rect.bottom > 0 && (!step.paper || !document.getElementById('pdfPages').hidden);
    const width = innerWidth; const height = innerHeight; const margin = 12;
    let left = 0; let top = 0; let right = 0; let bottom = 0;
    if (visible) {
      left = Math.max(4, rect.left - 5); top = Math.max(4, rect.top - 5);
      right = Math.min(width - 4, rect.right + 5); bottom = Math.min(height - 4, rect.bottom + 5);
    }
    highlight.hidden = !visible;
    Object.assign(highlight.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
    const shades = overlay.querySelectorAll('.tour-shade');
    const areas = visible ? [[0, 0, width, top], [0, top, left, bottom - top], [right, top, width - right, bottom - top], [0, bottom, width, height - bottom]] : [[0, 0, width, height], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    shades.forEach((shade, i) => {
      const [x, y, w, h] = areas[i];
      Object.assign(shade.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    });
    const w = bubble.offsetWidth; const h = bubble.offsetHeight;
    let x = (width - w) / 2; let y = (height - h) / 2;
    if (visible) {
      if (width - right >= w + margin * 2) { x = right + margin; y = top; }
      else if (left >= w + margin * 2) { x = left - w - margin; y = top; }
      else if (height - bottom >= h + margin * 2) { x = left; y = bottom + margin; }
      else if (top >= h + margin * 2) { x = left; y = top - h - margin; }
    }
    Object.assign(bubble.style, { left: `${Math.max(margin, Math.min(x, width - w - margin))}px`, top: `${Math.max(margin, Math.min(y, height - h - margin))}px` });
  }

  function render() {
    document.getElementById('tourProgress').textContent = `${index + 1} / ${steps.length}`;
    document.getElementById('tourTitle').textContent = steps[index].title;
    document.getElementById('tourText').textContent = steps[index].text;
    previous.disabled = index === 0;
    next.textContent = index === steps.length - 1 ? '完成' : '下一步';
    position();
    next.focus();
  }

  function finish(status) {
    try { localStorage.setItem(tourKey, status); } catch { /* Tour stays usable without storage. */ }
    overlay.hidden = true;
    surfaces.forEach((surface, i) => { surface.inert = originalInert[i]; });
    returnFocus?.focus();
  }

  function start() {
    if (!overlay.hidden) return;
    if (document.getElementById('importDialog').open) return;
    returnFocus = document.activeElement;
    originalInert = surfaces.map((surface) => surface.inert);
    surfaces.forEach((surface) => { surface.inert = true; });
    index = 0;
    overlay.hidden = false;
    render();
  }
  next.addEventListener('click', () => { if (index === steps.length - 1) finish('completed'); else { index += 1; render(); } });
  previous.addEventListener('click', () => { if (index > 0) { index -= 1; render(); } });
  skip.addEventListener('click', () => finish('skipped'));
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); finish('skipped'); }
    if (event.key === 'ArrowRight') { event.preventDefault(); next.click(); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); previous.click(); }
    if (event.key === 'Tab') {
      // Keep keyboard focus in the tour while the rest of the application is inert.
      const buttons = [...bubble.querySelectorAll('button')].filter((button) => !button.disabled);
      const current = buttons.indexOf(document.activeElement);
      const target = (current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[target].focus();
    }
  });
  window.addEventListener('resize', position);
  document.getElementById('helpButton').addEventListener('click', start);
  let seen = false;
  try { seen = !!localStorage.getItem(tourKey); } catch { /* First visit. */ }
  if (!seen) start();
}
