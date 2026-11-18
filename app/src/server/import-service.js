import { startImportTranslation } from './source-detection.js';

// Keep storage and job dependencies injectable so imports can be verified without external providers.
export function createPdfImporter(deps) {
  return async function importPdf({ pdfBuffer, metadata, body = {} }) {
    if (!pdfBuffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('上傳的檔案不是有效 PDF');
    const detected = await deps.detectPdfSource(metadata.fileName, pdfBuffer);
    const paper = deps.createPaperRecord({ ...metadata, ...deps.sourceSelection(body, detected) });
    await deps.mkdir(deps.paperDirectory(paper.id), { recursive: true });
    try {
      await deps.writeFile(deps.paperPdfPath(paper.id), pdfBuffer);
      await deps.mutateIndex((index) => { index.papers.unshift(paper); });
    } catch (error) {
      await deps.rm(deps.paperDirectory(paper.id), { recursive: true, force: true });
      throw error;
    }
    await deps.startParseJob(paper.id);
    // A translation setup failure must not undo an already saved import.
    try { await startImportTranslation(paper, body.autoTranslate, deps.startPdfTranslation, await deps.getAppSettings()); }
    catch (error) { console.error('Automatic PDF translation failed:', error.message); }
    return paper;
  };
}
