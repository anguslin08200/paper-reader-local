import { normalizeText } from '../shared/paper.js';

// Normalize both generations of the API before resolving any trusted paper data.
export async function resolveAttachments(body, elements, readElementImage) {
  const ids = Array.isArray(body.elementIds) ? body.elementIds : [body.elementId];
  const texts = Array.isArray(body.selectedTexts) ? body.selectedTexts : [{ text: body.selectedText, page: body.page, counterpart: body.counterpart }];
  const images = Array.isArray(body.images) ? body.images : [body.imageData];
  const seen = new Set();
  const unique = (key) => { if (seen.has(key)) return false; seen.add(key); return true; };
  // Keep original array indices so order metadata stays valid after filtering duplicates.
  const sources = {
    element: ids.slice(0, 100).map((id) => typeof id === 'string' ? elements.find((item) => item.id === id) : null),
    text: texts.slice(0, 100).map((value) => {
      if (!value || typeof value !== 'object') return null;
      const text = normalizeText(value.text).slice(0, 12000);
      return text ? { text, counterpart: normalizeText(value.counterpart).slice(0, 8000), page: Number(value.page) > 0 ? Math.floor(Number(value.page)) : undefined, label: normalizeText(value.label).slice(0, 120) } : null;
    }),
    image: images.slice(0, 100).map((value) => typeof value === 'string' && /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/.test(value) ? value : null),
  };
  const used = new Set();
  const attachments = [];
  let imageCount = 0;
  const consume = (type, index) => {
    if (!Number.isInteger(index) || index < 0 || index >= sources[type].length) return null;
    const key = `${type}:${index}`;
    if (used.has(key)) return null;
    used.add(key);
    const value = sources[type][index];
    if (!value) return null;
    const identity = type === 'element' ? value.id : type === 'text' ? JSON.stringify([value.text, value.page, value.counterpart]) : value;
    if (type === 'image' && imageCount >= 4) return null;
    if (!unique(`${type}:${identity}`)) return null;
    if (type === 'image') imageCount++;
    return value;
  };
  const add = (entry) => {
    if (attachments.length >= 6 || !entry || !Object.hasOwn(sources, entry.type)) return;
    const value = consume(entry.type, entry.index);
    if (!value) return;
    const attachment = { type: entry.type, [entry.type]: value, label: normalizeText(entry.label).slice(0, 120), page: Number(entry.page) > 0 ? Math.floor(Number(entry.page)) : undefined };
    // A crop can carry its element source or OCR text as one logical attachment.
    if (entry.type !== 'image' && entry.imageIndex !== undefined) attachment.image = consume('image', entry.imageIndex);
    if (entry.type !== 'text' && entry.textIndex !== undefined) attachment.text = consume('text', entry.textIndex);
    attachments.push(attachment);
  };
  // Legacy element and screenshot describe one selection, as in the original API.
  const legacy = !Array.isArray(body.elementIds) && !Array.isArray(body.images) && !Array.isArray(body.selectedTexts);
  if (Array.isArray(body.attachmentOrder)) body.attachmentOrder.slice(0, 100).forEach(add);
  else if (legacy && sources.element[0]) add({ type: 'element', index: 0, imageIndex: 0, textIndex: 0 });
  else if (legacy && sources.image[0]) add({ type: 'image', index: 0, textIndex: 0 });
  for (const type of ['element', 'text', 'image']) sources[type].forEach((_, index) => add({ type, index }));
  // Explicit images take precedence over automatically resolved element images.
  for (const attachment of attachments) {
    if (!attachment.image && attachment.element?.image && imageCount < 4) {
      const image = await readElementImage(attachment.element);
      if (image && unique(`image:${image}`)) { attachment.image = image; imageCount++; }
    }
  }
  return attachments;
}
