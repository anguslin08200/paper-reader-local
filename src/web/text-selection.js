// Port of pdf.js viewer's TextLayerBuilder selection handling (pdf_viewer.mjs, Apache-2.0).
// Without the movable "endOfContent" element, a drag that crosses whitespace between text spans
// extends the selection to the end of the page (thousands of characters on bilingual pages).

const textLayers = new Map();
let listening = false;

function reset(end, layer) {
  layer.append(end);
  end.style.width = '';
  end.style.height = '';
  end.style.userSelect = '';
  layer.classList.remove('selecting');
}

export function registerTextLayer(layer) {
  const end = document.createElement('div');
  end.className = 'endOfContent';
  layer.append(end);
  layer.addEventListener('mousedown', () => layer.classList.add('selecting'));
  textLayers.set(layer, end);
  enableGlobalListener();
}

export function unregisterMissingTextLayers() {
  // Pages are re-rendered on zoom/variant switches; drop layers no longer in the document.
  for (const layer of textLayers.keys()) if (!layer.isConnected) textLayers.delete(layer);
}

function enableGlobalListener() {
  if (listening) return;
  listening = true;
  let pointerDown = false;
  let previousRange = null;
  document.addEventListener('pointerdown', () => { pointerDown = true; });
  document.addEventListener('pointerup', () => { pointerDown = false; textLayers.forEach(reset); });
  window.addEventListener('blur', () => { pointerDown = false; textLayers.forEach(reset); });
  document.addEventListener('keyup', () => { if (!pointerDown) textLayers.forEach(reset); });
  document.addEventListener('selectionchange', () => {
    unregisterMissingTextLayers();
    const selection = document.getSelection();
    // A collapsed caret is not a selection: leaving the full-page helper up would swallow the next drag.
    if (!selection.rangeCount || selection.isCollapsed) { textLayers.forEach(reset); previousRange = null; return; }
    const active = new Set();
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      for (const layer of textLayers.keys()) if (!active.has(layer) && range.intersectsNode(layer)) active.add(layer);
    }
    for (const [layer, end] of textLayers) {
      if (active.has(layer)) layer.classList.add('selecting');
      else reset(end, layer);
    }
    // Move endOfContent right after the selection focus so the drag cannot jump past it.
    const range = selection.getRangeAt(0);
    const modifyStart = previousRange && (range.compareBoundaryPoints(Range.END_TO_END, previousRange) === 0 || range.compareBoundaryPoints(Range.START_TO_END, previousRange) === 0);
    let anchor = modifyStart ? range.startContainer : range.endContainer;
    if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
    if (!modifyStart && range.endOffset === 0) {
      do {
        while (!anchor.previousSibling) anchor = anchor.parentNode;
        anchor = anchor.previousSibling;
      } while (!anchor.childNodes.length);
    }
    const layer = anchor.parentElement?.closest('.textLayer');
    const end = textLayers.get(layer);
    if (end) {
      end.style.width = layer.style.width;
      end.style.height = layer.style.height;
      end.style.userSelect = 'text';
      anchor.parentElement.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
    }
    previousRange = range.cloneRange();
  });
}
