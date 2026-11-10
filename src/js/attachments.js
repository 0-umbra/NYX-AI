/**
 * Attachment pipeline for the NYX AI composer.
 *
 * Everything heavy (image decode/re-encode, PDF text extraction, scanned-PDF page rendering)
 * happens on-device. The Worker receives, per image, a base64 data URI re-encoded to satisfy
 * strict server-side limits, and per document, only the extracted text — never the original
 * file. Images are downscaled to LIMITS.maxImageEdge and recompressed until they fit
 * LIMITS.maxImageBytes. Scanned PDFs (no usable text layer) are rendered page by page, capped
 * at LIMITS.maxOcrPages, and sent through the vision model as images.
 *
 * This module is DOM-free except where marked (downscale/render). File-like objects passed to
 * the extractors are duck-typed ({ name, type, size, text(), arrayBuffer() }) so the logic is
 * unit-testable in Node.
 */
import { LIMITS } from './config.js';

export const IMAGE_EXTENSIONS = Object.freeze({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' });
export const DOCUMENT_EXTENSIONS = Object.freeze({ '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv' });
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DOCUMENT_MIMES = new Set(['application/pdf', 'text/plain', 'text/markdown', 'application/json', 'text/csv']);
export const SUPPORTED_LABELS = 'Images (JPEG, PNG, WebP) and documents (PDF, TXT, Markdown, JSON, CSV)';
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const ext = (name) => {
  const i = String(name ?? '').lastIndexOf('.');
  return i > 0 ? String(name).slice(i).toLowerCase() : '';
};

/** Classifies a file by declared MIME type first, then by extension (Android often reports none). */
export function classifyFile(file) {
  if (!file) return null;
  let mime = String(file.type ?? '').toLowerCase().trim();
  if (mime === 'image/jpg') mime = 'image/jpeg';
  if (IMAGE_MIMES.has(mime)) return { kind: 'image', mime, ext: ext(file.name) };
  if (DOCUMENT_MIMES.has(mime)) return { kind: 'document', mime, ext: ext(file.name) };
  const e = ext(file.name);
  if (IMAGE_EXTENSIONS[e]) return { kind: 'image', mime: IMAGE_EXTENSIONS[e], ext: e };
  if (DOCUMENT_EXTENSIONS[e]) return { kind: 'document', mime: DOCUMENT_EXTENSIONS[e], ext: e };
  return null;
}

/** Hard client-side check before any processing starts. */
export function validateFile(file) {
  if (!file) return { ok: false, error: 'The file could not be read.' };
  if (!Number.isFinite(file.size) || file.size <= 0) return { ok: false, error: `“${file.name ?? 'File'}” is empty.` };
  if (file.size > LIMITS.maxAttachmentBytes) {
    return { ok: false, error: `“${file.name}” is over the ${Math.round(LIMITS.maxAttachmentBytes / (1024 * 1024))} MB limit.` };
  }
  const kind = classifyFile(file);
  if (!kind) {
    return { ok: false, error: `“${file.name}” isn’t supported. Attach ${SUPPORTED_LABELS}.` };
  }
  return { ok: true, ...kind };
}

export function sniffImageMime(bytes) {
  if (!bytes || bytes.length < 4) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && PNG.every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

export function typeLabel(attachment) {
  const t = String(attachment?.type ?? attachment?.mime ?? '').toLowerCase();
  if (t.includes('jpeg') || t === 'image/jpg') return 'JPEG';
  if (t.includes('png')) return 'PNG';
  if (t.includes('webp')) return 'WEBP';
  if (t.includes('pdf')) return 'PDF';
  if (t.includes('markdown') || /\.(md|markdown)$/i.test(attachment?.name ?? '')) return 'MD';
  if (t.includes('json')) return 'JSON';
  if (t.includes('csv')) return 'CSV';
  if (t.includes('plain') || t === 'text/txt') return 'TXT';
  const e = ext(attachment?.name ?? '');
  return e ? e.slice(1).toUpperCase() : 'FILE';
}

/** Normalises extracted text and enforces the per-document character budget. */
export function cleanExtractedText(raw, { maxChars = LIMITS.maxDocumentChars } = {}) {
  const text = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n\n[…truncated to ${maxChars} characters]`, truncated: true };
}

/** Lazy PDF.js loader; the Worker (vendor/pdf.worker.min.mjs) is copied by scripts/build.js. */
async function defaultLoadDocument(data) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.min.mjs');
  // The vendored worker only exists in the built app; in Node tests pdf.js uses a fake worker.
  if (typeof document !== 'undefined') pdfjs.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.mjs';
  return pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true }).promise;
}

/**
 * Extracts text from a PDF. Stops as soon as the character budget is reached so a 500-page
 * scan is never fully read. Returns per-document text plus scanned-PDF detection.
 */
export async function extractPdfText(data, { maxChars = LIMITS.maxDocumentChars, maxPages = LIMITS.maxPdfPages, loadDocument = defaultLoadDocument } = {}) {
  const doc = await loadDocument(new Uint8Array(data));
  try {
    const pageCount = doc.numPages;
    // Strict page-iteration ceiling: a huge scanned PDF with no text layer must not keep
    // the device busy. Pages beyond the limit are never loaded or read.
    const pagesToRead = Math.min(pageCount, Math.max(1, maxPages));
    const parts = [];
    let total = 0;
    let pagesRead = 0;
    let truncated = false;
    for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => (typeof item.str === 'string' ? item.str : '')).join(' ').replace(/[ \t]+/g, ' ').trim();
      pagesRead = pageNumber;
      if (pageText) {
        const room = maxChars - total;
        if (room <= 0) { truncated = true; break; }
        const slice = pageText.slice(0, room);
        parts.push(slice);
        total += slice.length;
        if (slice.length < pageText.length || total >= maxChars) { truncated = true; break; }
      }
    }
    if (pageCount > pagesToRead) truncated = true;
    const text = parts.join('\n\n');
    const cleaned = cleanExtractedText(text, { maxChars });
    // A text layer yielding almost nothing means the pages are images (scanned).
    const likelyScanned = cleaned.text.replace(/\s+/g, '').length < 25;
    return { text: cleaned.text, truncated: truncated || cleaned.truncated, pageCount, likelyScanned, pagesRead };
  } finally {
    try { await doc.destroy(); } catch { /* already destroyed */ }
  }
}

/** Dispatches on document type. Returns { text, truncated, pageCount?, likelyScanned? }. */
export async function extractDocumentText(fileLike, options = {}) {
  const { maxChars = LIMITS.maxDocumentChars, loadDocument } = options;
  if ((fileLike.type ?? '').includes('pdf') || ext(fileLike.name) === '.pdf') {
    const buffer = await fileLike.arrayBuffer();
    return extractPdfText(buffer, { maxChars, loadDocument });
  }
  const raw = await fileLike.text();
  const cleaned = cleanExtractedText(raw, { maxChars });
  return { ...cleaned, pageCount: null, likelyScanned: false };
}

/**
 * Full PDF path: extracts the text layer, and when the PDF turns out to be scanned
 * (no usable text), renders the first LIMITS.maxOcrPages pages for vision-model OCR.
 */
export async function processPdfDocument(fileLike, { maxChars = LIMITS.maxDocumentChars, maxPages = LIMITS.maxOcrPages, loadDocument } = {}) {
  const buffer = await fileLike.arrayBuffer();
  const result = await extractPdfText(buffer, { maxChars, loadDocument });
  if (!result.likelyScanned) return result;
  const ocr = await renderPdfPagesToImages(buffer, { maxPages, loadDocument });
  return {
    ...result,
    text: '',
    ocrImages: ocr.images ?? [],
    ocrPageCount: result.pageCount,
    ocrUnavailable: ocr.unavailable === true,
  };
}

/**
 * Renders the first pages of a scanned PDF to JPEG data URIs for OCR through the vision model.
 * Browser-only: returns { images: [], unavailable: true } where canvas is missing (unit tests).
 */
export async function renderPdfPagesToImages(data, { maxPages = LIMITS.maxOcrPages, targetWidth = LIMITS.maxImageEdge, loadDocument = defaultLoadDocument } = {}) {
  if (typeof document === 'undefined') return { images: [], unavailable: true };
  const doc = await loadDocument(new Uint8Array(data));
  try {
    const images = [];
    const pages = Math.min(doc.numPages, maxPages);
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, Math.max(0.6, targetWidth / base.width));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      images.push({ data: canvas.toDataURL('image/jpeg', 0.82), mime: 'image/jpeg', page: pageNumber });
    }
    return { images, pageCount: doc.numPages, unavailable: false };
  } finally {
    try { await doc.destroy(); } catch { /* already destroyed */ }
  }
}

/**
 * Decodes, downscales to maxImageEdge and re-encodes an image. Prefers PNG when the source was
 * a PNG and stays under the byte budget (screenshots with text stay lossless); otherwise JPEG.
 * Also emits a tiny thumbnail for the conversation UI. Throws with a user-safe message on failure.
 */
export async function downscaleImageFile(fileLike, { maxEdge = LIMITS.maxImageEdge, maxBytes = LIMITS.maxImageBytes } = {}) {
  if (typeof createImageBitmap !== 'function' && typeof Image === 'undefined') {
    throw new Error('Image processing is not available in this environment.');
  }
  const sourceType = String(fileLike.type ?? '').toLowerCase();
  let bitmap;
  try {
    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(fileLike);
    }
  } catch {
    throw new Error('That image could not be read. It may be corrupt or an unsupported format.');
  }
  if (!bitmap) throw new Error('That image could not be read. It may be corrupt or an unsupported format.');

  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!canvas) throw new Error('Image processing is not available in this environment.');
  const ctx = canvas.getContext('2d');

  const encode = (width, height) => {
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas;
  };

  const tryEncode = (edge, type, quality) => {
    const ratio = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * ratio));
    const height = Math.max(1, Math.round(bitmap.height * ratio));
    encode(width, height);
    const data = canvas.toDataURL(type, quality);
    const bytes = Math.floor((data.length - data.indexOf(',') - 1) * 3 / 4);
    return { data, mime: type, width, height, bytes };
  };

  const attempts = [];
  if (sourceType === 'image/png') attempts.push([maxEdge, 'image/png', 1]);
  for (const edge of [maxEdge, 768, 512]) {
    for (const quality of [0.85, 0.75, 0.62]) attempts.push([edge, 'image/jpeg', quality]);
  }

  let result = null;
  for (const [edge, type, quality] of attempts) {
    const candidate = tryEncode(edge, type, quality);
    if (candidate.bytes <= maxBytes) { result = candidate; break; }
  }
  if (!result) throw new Error('That image stays too large even after compression. Try a smaller one.');

  // A small persisted thumbnail so previous images remain visible in history.
  let thumb = null;
  try {
    const ratio = Math.min(1, 96 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * ratio));
    const height = Math.max(1, Math.round(bitmap.height * ratio));
    encode(width, height);
    const data = canvas.toDataURL('image/jpeg', 0.7);
    if (data.length <= LIMITS.maxStoredImageThumbChars) thumb = data;
  } catch { /* thumbnail is optional */ }

  try { bitmap.close?.(); } catch { /* already closed */ }

  return { ...result, thumb, sourceMime: sourceType || 'image/jpeg' };
}

/**
 * Converts ready composer attachments into the wire payload, expanding scanned-PDF OCR pages
 * into one image each (counted against the attachment cap). Returns { attachments } or { error }.
 */
export function buildSendAttachments(ready, { maxImages = 5, maxTotalDocumentChars = LIMITS.maxTotalDocumentChars, maxDocumentChars = LIMITS.maxDocumentChars } = {}) {
  const wire = [];
  const map = []; // wireIndex -> { entryId, role, page? }
  let imageCount = 0;
  let documentChars = 0;
  let payloadBytes = 0;

  for (const entry of ready) {
    if (entry.kind === 'image') {
      imageCount += 1;
      wire.push({ name: entry.name, kind: 'image', mime: entry.mime, data: entry.data });
      map.push({ entryId: entry.id, role: 'image' });
      payloadBytes += entry.data.length;
      continue;
    }
    if (entry.ocrImages?.length) {
      for (const page of entry.ocrImages) {
        imageCount += 1;
        const base = entry.name.replace(/\.pdf$/i, '').slice(0, 80);
        wire.push({ name: `${base} page ${page.page}.jpg`, kind: 'image', mime: 'image/jpeg', data: page.data, ocr: true });
        map.push({ entryId: entry.id, role: 'ocrPage', page: page.page });
        payloadBytes += page.data.length;
      }
      continue;
    }
    const text = String(entry.text ?? '').slice(0, maxDocumentChars);
    documentChars += text.length;
    wire.push({ name: entry.name, kind: 'document', mime: entry.mime ?? 'text/plain', text, truncated: entry.truncated === true });
    map.push({ entryId: entry.id, role: 'document' });
    payloadBytes += text.length;
  }

  if (imageCount > maxImages) {
    return { error: `Too many images after OCR pages were added. Remove one (the limit is ${maxImages}).` };
  }
  if (documentChars > maxTotalDocumentChars) {
    return { error: 'The attached documents are too large to analyse together. Remove one and try again.' };
  }
  if (wire.length > LIMITS.maxAttachments) {
    return { error: `You can attach up to ${LIMITS.maxAttachments} files.` };
  }
  if (payloadBytes > LIMITS.maxRequestBytes * 0.9) {
    return { error: 'The attachments are too large to send together. Remove one and try again.' };
  }
  return { attachments: wire, map };
}

/**
 * Merges the Worker's attachmentResults (in wire order) back into the composer attachment
 * entries, so the message that is stored carries the analyses for follow-ups.
 */
export function mergeAnalyses(entries, wireMap, results) {
  if (!Array.isArray(results) || results.length === 0) return entries;
  const next = entries.map((entry) => ({ ...entry }));
  const byId = new Map(next.map((entry) => [entry.id, entry]));
  let imageIndex = 0;
  for (const wire of wireMap ?? []) {
    if (wire.role !== 'image' && wire.role !== 'ocrPage') continue;
    const result = results[imageIndex];
    imageIndex += 1;
    if (!result || typeof result.analysis !== 'string' || !result.analysis.trim()) continue;
    const entry = byId.get(wire.entryId);
    if (!entry) continue;
    if (wire.role === 'image') {
      entry.analysis = result.analysis.slice(0, LIMITS.maxAnalysisChars);
    } else {
      const marker = `[page ${wire.page}] ${result.analysis}`.slice(0, 1200);
      entry.extractedText = `${entry.extractedText ?? ''}${entry.extractedText ? '\n\n' : ''}${marker}`.slice(0, LIMITS.maxStoredExtractedChars);
      entry.ocrPagesRead = (entry.ocrPagesRead ?? 0) + 1;
    }
  }
  return next;
}
