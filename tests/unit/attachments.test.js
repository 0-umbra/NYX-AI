/** Unit tests for the on-device attachment pipeline (no network, no DOM unless marked). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFile, validateFile, sniffImageMime, typeLabel, cleanExtractedText,
  extractDocumentText, extractPdfText, buildSendAttachments, mergeAnalyses,
} from '../../src/js/attachments.js';
import { LIMITS } from '../../src/js/config.js';

const fileLike = (name, mime, content, { size } = {}) => ({
  name,
  type: mime,
  size: size ?? (typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength),
  text: async () => (typeof content === 'string' ? content : Buffer.from(content).toString('utf8')),
  arrayBuffer: async () => {
    if (typeof content === 'string') return new TextEncoder().encode(content).buffer;
    return content instanceof Uint8Array ? content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) : content;
  },
});

// --- classification & validation ---------------------------------------------

test('classifyFile: accepts JPEG/PNG/WebP images by MIME and by extension', () => {
  assert.equal(classifyFile({ name: 'a.jpg', type: 'image/jpeg' }).kind, 'image');
  assert.equal(classifyFile({ name: 'a.png', type: 'image/png' }).mime, 'image/png');
  assert.equal(classifyFile({ name: 'a.webp', type: 'image/webp' }).mime, 'image/webp');
  // Android often reports an empty type: fall back to the extension.
  assert.equal(classifyFile({ name: 'a.JPEG', type: '' }).mime, 'image/jpeg');
  assert.equal(classifyFile({ name: 'a.png', type: '' }).mime, 'image/png');
  assert.equal(classifyFile({ name: 'a.webp', type: 'application/octet-stream' }).mime, 'image/webp');
});

test('classifyFile: accepts PDF/TXT/MD/JSON/CSV documents', () => {
  assert.equal(classifyFile({ name: 'a.pdf', type: 'application/pdf' }).kind, 'document');
  assert.equal(classifyFile({ name: 'a.txt', type: 'text/plain' }).mime, 'text/plain');
  assert.equal(classifyFile({ name: 'a.md', type: '' }).mime, 'text/markdown');
  assert.equal(classifyFile({ name: 'a.json', type: 'application/json' }).mime, 'application/json');
  assert.equal(classifyFile({ name: 'a.csv', type: '' }).mime, 'text/csv');
  assert.equal(classifyFile({ name: 'a.markdown', type: '' }).mime, 'text/markdown');
});

test('classifyFile: rejects unsupported types', () => {
  for (const name of ['a.gif', 'a.exe', 'a.docx', 'a.zip', 'a.heic', 'noext']) {
    assert.equal(classifyFile({ name, type: '' }), null, name);
  }
  assert.equal(classifyFile({ name: 'a.svg', type: 'image/svg+xml' }), null);
});

test('validateFile: enforces size limits with clear errors', () => {
  assert.equal(validateFile({ name: 'x.txt', type: 'text/plain', size: 0 }).ok, false);
  const big = validateFile({ name: 'big.pdf', type: 'application/pdf', size: LIMITS.maxAttachmentBytes + 1 });
  assert.equal(big.ok, false);
  assert.match(big.error, /limit/i);
  const ok = validateFile({ name: 'ok.txt', type: 'text/plain', size: 100 });
  assert.equal(ok.ok, true);
});

test('validateFile: unsupported files name the allowed types', () => {
  const bad = validateFile({ name: 'evil.exe', type: 'application/x-msdownload', size: 100 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /JPEG|PNG|WebP|PDF|TXT/i);
});

// --- image sniffing ----------------------------------------------------------

test('sniffImageMime: detects jpeg, png, webp; rejects others', () => {
  assert.equal(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x40, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
  assert.equal(sniffImageMime(webp), 'image/webp');
  assert.equal(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38])), null);
  assert.equal(sniffImageMime(new Uint8Array([])), null);
});

// --- labels ------------------------------------------------------------------

test('typeLabel: human-readable type labels', () => {
  assert.equal(typeLabel({ name: 'a.jpg', type: 'image/jpeg' }), 'JPEG');
  assert.equal(typeLabel({ name: 'a.png', type: 'image/png' }), 'PNG');
  assert.equal(typeLabel({ name: 'a.webp', type: 'image/webp' }), 'WEBP');
  assert.equal(typeLabel({ name: 'a.pdf', type: 'application/pdf' }), 'PDF');
  assert.equal(typeLabel({ name: 'a.md', type: 'text/markdown' }), 'MD');
  assert.equal(typeLabel({ name: 'a.json', type: 'application/json' }), 'JSON');
  assert.equal(typeLabel({ name: 'a.csv', type: 'text/csv' }), 'CSV');
  assert.equal(typeLabel({ name: 'a.txt', type: 'text/plain' }), 'TXT');
});

// --- text extraction ----------------------------------------------------------

test('cleanExtractedText: normalises and enforces the character budget', () => {
  const clean = cleanExtractedText('  a\r\n\r\n\r\n b\u0000\tc  ');
  assert.equal(clean.text, 'a\n\n b\tc'.replace(/ +/g, ' '));
  const long = cleanExtractedText('x'.repeat(LIMITS.maxDocumentChars + 100));
  assert.equal(long.truncated, true);
  assert.ok(long.text.length <= LIMITS.maxDocumentChars + 60);
  assert.match(long.text, /truncated/);
});

test('extractDocumentText: reads txt, md, json and csv as text', async () => {
  for (const [name, mime, content] of [
    ['notes.txt', 'text/plain', 'hello world'],
    ['README.md', 'text/markdown', '# Title\n\nbody'],
    ['data.json', 'application/json', '{"a": 1}'],
    ['rows.csv', 'text/csv', 'a,b\n1,2'],
  ]) {
    const result = await extractDocumentText(fileLike(name, mime, content));
    assert.equal(result.likelyScanned, false);
    assert.ok(result.text.includes(content.split('\n')[0].slice(0, 8)));
  }
  const empty = await extractDocumentText(fileLike('empty.txt', 'text/plain', '   '));
  assert.equal(empty.text, '');
});

/** Builds a minimal one-page PDF with a text layer (validated against the real PDF.js below). */
function samplePdfBytes(text) {
  const lines = String(text).split('\n').map((l) => l.replace(/[\\()]/g, (c) => `\\${c}`));
  const ops = ['BT /F1 12 Tf 72 750 Td'];
  lines.forEach((line, i) => {
    if (i) ops.push('0 -14 Td');
    ops.push(`(${line}) Tj`);
  });
  ops.push('ET');
  const content = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

test('extractPdfText: extracts text from a real PDF via PDF.js', async () => {
  const bytes = samplePdfBytes('Hello NYX AI attachment test fixture with plenty of text to read');
  const result = await extractPdfText(bytes);
  assert.equal(result.pageCount, 1);
  assert.match(result.text, /attachment test fixture/);
  assert.equal(result.likelyScanned, false);
});

test('extractPdfText: a PDF with no text layer is flagged as scanned', async () => {
  const bytes = samplePdfBytes('');
  const result = await extractPdfText(bytes);
  assert.equal(result.text, '');
  assert.equal(result.likelyScanned, true);
});

test('extractPdfText: stops at the character budget for huge documents', async () => {
  const body = Array.from({ length: 120 }, (_, i) => `LINE-${String(i).padStart(3, '0')} ${'x'.repeat(48)}`).join('\n');
  const bytes = samplePdfBytes(body);
  const result = await extractPdfText(bytes, { maxChars: 200 });
  assert.ok(result.text.length <= 260, `got ${result.text.length}`);
  assert.equal(result.truncated, true);
});

// --- wire payload building ----------------------------------------------------

const readyImage = (id, name = `${id}.png`) => ({
  id, kind: 'image', name, size: 1234, type: 'image/png', status: 'ready',
  mime: 'image/png', data: `data:image/png;base64,${'A'.repeat(100)}`,
});
const readyDoc = (id, text = 'document text', name = `${id}.txt`) => ({
  id, kind: 'document', name, size: text.length, type: 'text/plain', status: 'ready',
  mime: 'text/plain', text,
});
const readyScan = (id, pages = 3) => ({
  id, kind: 'document', name: `${id}.pdf`, size: 9999, type: 'application/pdf', status: 'ready',
  scanned: true, text: '', pageCount: 9,
  ocrImages: Array.from({ length: pages }, (_, i) => ({ data: `data:image/jpeg;base64,${'B'.repeat(80)}`, mime: 'image/jpeg', page: i + 1 })),
});

test('buildSendAttachments: expands scanned PDFs into bounded OCR page images', () => {
  const { attachments, map } = buildSendAttachments([readyScan('doc', 3)]);
  assert.equal(attachments.length, 3);
  assert.deepEqual(attachments.map((a) => a.ocr), [true, true, true]);
  assert.deepEqual(map.map((m) => m.role), ['ocrPage', 'ocrPage', 'ocrPage']);
  assert.match(attachments[0].name, /page 1\.jpg$/);
});

test('buildSendAttachments: OCR pages and images count against the five image cap', () => {
  const entries = [readyScan('doc', 3), readyImage('a'), readyImage('b'), readyImage('c')];
  const result = buildSendAttachments(entries);
  assert.match(result.error, /too many images/i);
});

test('buildSendAttachments: document text is bounded per document and in total', () => {
  const big = readyDoc('big', 'y'.repeat(LIMITS.maxDocumentChars + 500), 'big.txt');
  const { attachments } = buildSendAttachments([big]);
  assert.ok(attachments[0].text.length <= LIMITS.maxDocumentChars);
  const docs = [
    readyDoc('d1', 'a'.repeat(LIMITS.maxDocumentChars)),
    readyDoc('d2', 'b'.repeat(LIMITS.maxDocumentChars)),
  ];
  const over = buildSendAttachments(docs);
  assert.match(over.error, /too large/i);
});

test('buildSendAttachments: more than five images are refused', () => {
  const entries = Array.from({ length: 6 }, (_, i) => readyImage(`i${i}`));
  const result = buildSendAttachments(entries);
  assert.match(result.error, /too many images/i);
});

test('mergeAnalyses: merges results back into composer entries by wire order', () => {
  const entries = [readyImage('img1', 'one.png'), readyScan('doc', 2)];
  const wire = buildSendAttachments(entries);
  const results = wire.map.map((m) => ({ name: m.role === 'image' ? 'one.png' : `doc page ${m.page}.jpg`, analysis: `analysis-${m.role}-${m.page ?? 0}` }));
  const merged = mergeAnalyses(entries, wire.map, results);
  assert.equal(merged[0].analysis, 'analysis-image-0');
  assert.match(merged[1].extractedText, /\[page 1\]/);
  assert.match(merged[1].extractedText, /\[page 2\]/);
  assert.equal(merged[1].ocrPagesRead, 2);
});

test('mergeAnalyses: missing or empty results leave entries untouched', () => {
  const entries = [readyImage('img1')];
  const wire = buildSendAttachments(entries);
  assert.equal(mergeAnalyses(entries, wire.map, undefined)[0].analysis, undefined);
  assert.equal(mergeAnalyses(entries, wire.map, [])[0].analysis, undefined);
  assert.equal(mergeAnalyses(entries, wire.map, [{ name: 'one.png', analysis: '   ' }])[0].analysis, undefined);
});
