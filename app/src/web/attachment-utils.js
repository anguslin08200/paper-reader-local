// Keep multi-selection and request serialization pure so limits/order can be tested without a PDF.
export function attachmentKey(item) {
  if (item.elementId) return `element:${item.elementId}`;
  if (item.text && !item.imageData) return `text:${item.variant || ''}:${item.page || ''}:${item.text}`;
  return item.id || item.imageData;
}

export function updateAttachments(current, item, additive = false) {
  if (!additive) return { attachments: [item] };
  const key = attachmentKey(item);
  const index = current.findIndex((entry) => attachmentKey(entry) === key);
  // Repeated Ctrl-clicks toggle elements. Repeated keyboard selection notifications keep text once.
  if (index >= 0) return { attachments: item.elementId ? current.filter((_, i) => i !== index) : current };
  if (current.length >= 6) return { attachments: current, error: '每次提問最多附上 6 項內容' };
  if (item.imageData && current.filter((entry) => entry.imageData).length >= 4) {
    return { attachments: current, error: '每次提問最多附上 4 張截圖或上傳圖片' };
  }
  return { attachments: [...current, item] };
}

export function attachmentPayload(attachments) {
  const payload = { elementIds: [], images: [], selectedTexts: [], attachmentOrder: [] };
  for (const item of attachments.slice(0, 6)) {
    const order = { label: item.label, page: item.page };
    if (item.elementId) { order.type = 'element'; order.index = payload.elementIds.push(item.elementId) - 1; }
    if (item.imageData && payload.images.length < 4) {
      const index = payload.images.push(item.imageData) - 1;
      if (order.type) order.imageIndex = index;
      else { order.type = 'image'; order.index = index; }
    }
    if (item.text) {
      const index = payload.selectedTexts.push({ text: item.text, page: item.page, counterpart: item.counterpart || '', label: item.label }) - 1;
      if (order.type) order.textIndex = index;
      else { order.type = 'text'; order.index = index; }
    }
    if (order.type) payload.attachmentOrder.push(order);
  }
  payload.attachmentLabel = attachments.map((item) => item.label).join('、');
  return payload;
}
