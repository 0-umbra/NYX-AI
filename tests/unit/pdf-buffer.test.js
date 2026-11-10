/**
 * Regression tests for the PDF.js ArrayBuffer-detachment bug.
 *
 * The bug has two parts, and they are deliberately kept distinct here:
 *
 *  1. FIRST-LOAD DETACHMENT (always happens). `getDocument()` hands the caller's ArrayBuffer to
 *     PDF.js's Worker as a *transferable*, which permanently detaches it. Every PDF.js document
 *     load therefore consumes whatever buffer it is given.
 *  2. CONDITIONAL OCR REUSE (the reported crash). The old pipeline had exactly one buffer for the
 *     whole document. When the document was classified as scanned, that same — now detached —
 *     buffer was reused for the page-rendering pass, which can only fail with
 *     "Cannot perform Construct on a detached ArrayBuffer".
 *
 * Whether a second load happens at all depends on classification, and this is *not* simply
 * "scanned vs text": `processPdfDocument()` calls `renderPdfPagesToImages()` only when
 * `likelyScanned` is true, and `likelyScanned` means "fewer than 25 non-space characters were
 * extracted". So a long text PDF takes one load and always worked; a scanned PDF, and any PDF
 * whose text layer is short (a cover page, a one-word form, a signature scan), took the second
 * load and failed. Verified against the pre-fix code: the long-text PDF succeeded, the other two
 * threw the detached-buffer error.
 *
 * The fix is purely about who owns the bytes; no limit, validation step or upload policy changed.
 *
 * These tests are written to fail on that implementation and pass on the fix, in both directions:
 *  - a *simulated* PDF.js worker that really detaches its input (a real `structuredClone` transfer),
 *    so the detachment is exercised deterministically rather than depending on PDF.js internals;
 *  - the real PDF.js in Node, to prove the shipped code path also keeps the bytes usable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  withPdfBytes,
  createCopyReport,
  extractPdfText,
  renderPdfPagesToImages,
  processPdfDocument,
  extractDocumentText,
} from '../../src/js/attachments.js';
import { LIMITS } from '../../src/js/config.js';

// --- fixtures: minimal, valid PDFs (the same construction the existing suite validates) --------

function assemblePdf(objects) {
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

function samplePdfBytes(text) {
  const lines = String(text).split('\n').map((l) => l.replace(/[\\()]/g, (c) => `\\${c}`));
  const ops = ['BT /F1 12 Tf 72 750 Td'];
  lines.forEach((line, i) => {
    if (i) ops.push('0 -14 Td');
    ops.push(`(${line}) Tj`);
  });
  ops.push('ET');
  const content = ops.join('\n');
  return assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

/** Multi-page PDF. pageText(n) returns that page's text; '' leaves the page without a text layer. */
function multiPagePdfBytes(pageCount, pageText = () => '') {
  const fontId = 3 + pageCount * 2;
  const kids = [];
  for (let i = 0; i < pageCount; i += 1) kids.push(`${3 + i * 2} 0 R`);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`,
  ];
  for (let i = 0; i < pageCount; i += 1) {
    const pageId = 3 + i * 2;
    const contentId = pageId + 1;
    const line = String(pageText(i + 1) ?? '').replace(/[\\()]/g, (c) => `\\${c}`).slice(0, 200);
    const stream = line ? `BT /F1 12 Tf 72 750 Td (${line}) Tj ET` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  return assemblePdf(objects);
}

/** An exactly-sized ArrayBuffer copy, i.e. what `File#arrayBuffer()` hands the pipeline. */
const toBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

/** A file-like object shaped like the browser File the composer passes in. */
const pdfFile = (bytes, name = 'document.pdf') => ({
  name,
  type: 'application/pdf',
  size: bytes.byteLength,
  arrayBuffer: async () => toBuffer(bytes),
});

// --- a simulated PDF.js worker that really detaches its input --------------------------------

/**
 * Stands in for PDF.js: it does to its input exactly what the real library does to the buffer it
 * is given — transfers it away, detaching the caller's ArrayBuffer — and then behaves like a
 * loaded document so the rest of the pipeline runs unchanged.
 */
function detachingLoader({ pages = [''], detach = (buffer) => structuredClone(buffer, { transfer: [buffer] }) } = {}) {
  const received = [];
  const load = async (data) => {
    received.push(data);
    // The real library's failure mode, reproduced faithfully:
    //   messageHandler.sendWithPromise('GetDocRequest', params, [data.buffer])
    detach(data.buffer);
    assert.equal(data.byteLength, 0, 'the simulated worker must detach what it is given');
    let destroyed = false;
    return {
      numPages: pages.length,
      async getPage(pageNumber) {
        if (destroyed) throw new Error('getPage after destroy');
        const text = pages[pageNumber - 1] ?? '';
        return {
          getTextContent: async () => ({ items: text ? [{ str: text }] : [] }),
          getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }),
          render: () => ({ promise: Promise.resolve() }),
        };
      },
      async destroy() { destroyed = true; },
    };
  };
  return { load, received, destroyed: () => received.length };
}

const withCanvas = (run) => {
  // renderPdfPagesToImages is browser-only. The stub canvas tolerates whatever the renderer calls
  // (it is a permissive no-op context), so real PDF.js can paint into it in Node.
  const makeCanvas = () => {
    const canvas = {
      width: 0,
      height: 0,
      toDataURL: () => 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==',
    };
    const context = new Proxy({ canvas }, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === 'measureText') return () => ({ width: 10 });
        if (prop === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)) });
        if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
        if (prop === 'getLineDash') return () => [];
        if (prop === 'canvas') return canvas;
        return () => {};
      },
      set(target, prop, value) { target[prop] = value; return true; },
    });
    canvas.getContext = () => context;
    return canvas;
  };
  globalThis.document = { createElement: () => makeCanvas() };
  return Promise.resolve()
    .then(run)
    .finally(() => { delete globalThis.document; });
};

// --- the arena itself --------------------------------------------------------

test('withPdfBytes: takes ONE snapshot copy and exposes its size', () => {
  const bytes = samplePdfBytes('hello');
  const report = createCopyReport();
  const arena = withPdfBytes(bytes, { report });
  assert.equal(arena.length, bytes.byteLength);
  assert.deepEqual(report.stages(), ['snapshot'], 'construction copies the document exactly once');
  assert.equal(report.totalBytes, bytes.byteLength);
  assert.equal(arena.snapshotDetached, false);
});

test('withPdfBytes: each load gets one independent, exactly-sized transferable copy', async () => {
  const bytes = samplePdfBytes('hello');
  const report = createCopyReport();
  const arena = withPdfBytes(bytes, { report });

  const received = [];
  const load = async (copy) => { received.push(copy); return { numPages: 0 }; };
  await arena.load(load);
  await arena.load(load);

  assert.equal(received.length, 2);
  assert.notEqual(received[0], received[1], 'each load gets its own array');
  assert.notEqual(received[0].buffer, received[1].buffer, 'each load gets its own ArrayBuffer');
  for (const copy of received) {
    assert.equal(copy.byteLength, bytes.byteLength);
    assert.equal(copy.byteLength, copy.buffer.byteLength, 'exactly sized, so PDF.js makes no internal copy');
    assert.deepEqual([...copy], [...bytes]);
  }
  assert.deepEqual(report.stages(), ['snapshot', 'transfer', 'transfer']);
  assert.equal(report.count, 3, 'one snapshot + one copy per load');
});

test('withPdfBytes: a loader may detach its own copy while the snapshot stays intact', async () => {
  const bytes = samplePdfBytes('detach me');
  const arena = withPdfBytes(bytes);

  // The loader does exactly what PDF.js does: transfers the buffer away.
  const load = async (copy) => { structuredClone(copy.buffer, { transfer: [copy.buffer] }); return { numPages: 0 }; };
  await arena.load(load);

  assert.equal(arena.snapshotDetached, false, 'the pristine snapshot is never transferred');
  assert.equal(arena.anyHandedOutDetached, true, 'the buffer handed to the loader was detached');
  assert.deepEqual(arena.handedOut, [{ length: 0, detached: true }]);

  // ...and the arena can still serve another load with full content.
  let second;
  await arena.load(async (copy) => { second = copy; return { numPages: 0 }; });
  assert.equal(second.byteLength, bytes.byteLength);
  assert.deepEqual([...second], [...bytes], 'later loads are unaffected by the earlier detachment');
  assert.deepEqual(arena.handedOut, [
    { length: 0, detached: true },
    { length: bytes.byteLength, detached: false },
  ]);
});

test('withPdfBytes: handedOut tracking is empty until a load happens', () => {
  const arena = withPdfBytes(samplePdfBytes('x'));
  assert.deepEqual(arena.handedOut, []);
  assert.equal(arena.anyHandedOutDetached, false);
  assert.equal(arena.snapshotDetached, false);
});

test('withPdfBytes: accepts ArrayBuffer, any TypedArray view and Buffer', () => {
  const bytes = samplePdfBytes('view tolerance');
  const view = new Uint8Array(10 + bytes.byteLength);
  view.set(bytes, 5); // deliberately offset, as a pooled Buffer would be
  const offsetView = new Uint8Array(view.buffer, 5, bytes.byteLength);

  for (const input of [toBuffer(bytes), bytes, offsetView, Buffer.from(bytes)]) {
    const report = createCopyReport();
    const arena = withPdfBytes(input, { report });
    assert.equal(arena.length, bytes.byteLength, `input ${input.constructor.name}`);
    assert.deepEqual([...arena.handedOut], []);
    let copy;
    arena.load((value) => { copy = value; return { numPages: 0 }; });
    assert.deepEqual([...copy], [...bytes], `content for ${input.constructor.name}`);
    // Only the document's own bytes are copied, never the surrounding pooled buffer.
    assert.equal(report.totalBytes, bytes.byteLength * 2);
  }
});

// --- the reported bug, reproduced and fixed ------------------------------------------------

/**
 * End-to-end copy accounting. `createCopyReport()` records every whole-document copy the pipeline
 * makes; the numbers below are the contract:
 *   text PDF    → 1 snapshot + 1 transferable copy            (one document load)
 *   scanned PDF → 1 snapshot + 2 transferable copies          (text load + OCR load)
 * Anything larger means a redundant copy crept back into the chain.
 */
test('copy accounting: a text PDF costs one snapshot plus one transfer copy', async () => {
  const bytes = samplePdfBytes('A text layer long enough that this document is not treated as scanned');
  const report = createCopyReport();
  const result = await processPdfDocument(pdfFile(bytes), { report });

  assert.equal(result.likelyScanned, false);
  assert.deepEqual(report.stages(), ['snapshot', 'transfer']);
  assert.equal(report.count, 2, `expected 2 whole-document copies, got ${report.count}`);
  assert.equal(report.totalBytes, bytes.byteLength * 2);
});

test('copy accounting: a scanned PDF costs one snapshot plus two transfer copies', async () => {
  const bytes = samplePdfBytes('');
  await withCanvas(async () => {
    const report = createCopyReport();
    const result = await processPdfDocument(pdfFile(bytes), { report });
    assert.equal(result.likelyScanned, true);
    assert.deepEqual(report.stages(), ['snapshot', 'transfer', 'transfer'], 'one copy per document load');
    assert.equal(report.count, 3, `expected 3 whole-document copies, got ${report.count}`);
    assert.equal(report.totalBytes, bytes.byteLength * 3);
  });
});

test('copy accounting: the snapshot is taken once even when both passes run', async () => {
  const bytes = samplePdfBytes('');
  await withCanvas(async () => {
    const report = createCopyReport();
    const arena = withPdfBytes(bytes, { report });
    // Both public functions reuse the same arena: the document is never re-snapshotted.
    await extractPdfText(null, { bytes: arena, report });
    await renderPdfPagesToImages(null, { bytes: arena, report });
    assert.deepEqual(report.stages(), ['snapshot', 'transfer', 'transfer']);
    assert.equal(report.count, 3);
  });
});

test('copy accounting: standalone calls each snapshot once (they own their input)', async () => {
  const bytes = samplePdfBytes('standalone calls still snapshot once each');
  const report = createCopyReport();
  await extractPdfText(bytes, { report });          // snapshot + 1 transfer
  await extractPdfText(bytes, { report });          // snapshot + 1 transfer
  assert.deepEqual(report.stages(), ['snapshot', 'transfer', 'snapshot', 'transfer']);
  assert.equal(report.count, 4);
});

test('copy accounting: no copy grows with page count', async () => {
  const onePage = createCopyReport();
  await processPdfDocument(pdfFile(samplePdfBytes('single page with a long enough text layer here')), { report: onePage });
  const manyPages = createCopyReport();
  await processPdfDocument(pdfFile(multiPagePdfBytes(40, (page) => `page ${page} has a readable text layer`)), { report: manyPages });
  assert.equal(onePage.count, 2);
  assert.equal(manyPages.count, 2, 'copies are per document load, never per page');
  assert.deepEqual(manyPages.stages(), ['snapshot', 'transfer']);
});

test('ordinary text-based PDF: text is extracted and the caller bytes stay usable', async () => {
  const bytes = samplePdfBytes('Quarterly revenue grew 12 percent across all regions');
  const caller = toBuffer(bytes);

  const result = await extractPdfText(caller);

  assert.equal(result.likelyScanned, false);
  assert.match(result.text, /Quarterly revenue grew 12 percent/);
  assert.equal(result.pageCount, 1);
  assert.equal(caller.byteLength, bytes.byteLength, 'PDF.js must not detach the caller buffer');
  assert.deepEqual([...new Uint8Array(caller)], [...bytes]);
});

test('reuse after extraction: the same bytes can be loaded a second and third time', async () => {
  const bytes = samplePdfBytes('Reusable bytes for a second pass over the same document');
  const caller = toBuffer(bytes);

  const first = await extractPdfText(caller);
  const second = await extractPdfText(caller);
  const third = await extractPdfText(new Uint8Array(caller));

  for (const result of [first, second, third]) {
    assert.match(result.text, /Reusable bytes for a second pass/);
  }
  assert.equal(caller.byteLength, bytes.byteLength);
});

test('scanned PDF OCR: rendering works after text extraction detached its own copy', async () => {
  const bytes = samplePdfBytes(''); // no text layer → scanned
  await withCanvas(async () => {
    const { load, received } = detachingLoader({ pages: ['', '', ''] });
    const result = await processPdfDocument(pdfFile(bytes), { loadDocument: load, maxPages: 3 });

    assert.equal(result.likelyScanned, true, 'the fixture is treated as scanned');
    assert.equal(result.ocrImages.length, 3, 'every OCR page is rendered');
    assert.equal(result.ocrUnavailable, false);
    assert.equal(received.length, 2, 'exactly two document loads: text pass + OCR pass');
    for (const [index, data] of received.entries()) {
      assert.equal(data.byteLength, 0, `load ${index + 1} was detached by the loader (as PDF.js does)`);
    }
  });
});

test('scanned PDF OCR: each PDF.js load receives its own independent bytes', async () => {
  const bytes = samplePdfBytes('');
  await withCanvas(async () => {
    const { load, received } = detachingLoader({ pages: ['', ''] });
    await processPdfDocument(pdfFile(bytes), { loadDocument: load, maxPages: 2 });
    assert.equal(received.length, 2);
    assert.notEqual(received[0].buffer, received[1].buffer, 'one buffer per load, never shared');
    assert.equal(received[0].byteLength, 0);
    assert.equal(received[1].byteLength, 0);
  });
});

test('a simulated detaching worker cannot break text extraction (regression: detached ArrayBuffer)', async () => {
  const bytes = samplePdfBytes('Detaching worker regression fixture with real content');
  const { load, received } = detachingLoader({ pages: ['Detaching worker regression fixture with real content'] });

  const result = await extractPdfText(bytes, { loadDocument: load });

  assert.match(result.text, /Detaching worker regression fixture/);
  assert.equal(received[0].byteLength, 0, 'the loader detached the buffer it was given');
  assert.notEqual(bytes.byteLength, 0, 'the caller still has its bytes');
  assert.match(new TextDecoder().decode(bytes), /^%PDF-1\.4/);
});

test('renderPdfPagesToImages: the caller buffer survives and the load was detached', async () => {
  const bytes = samplePdfBytes('');
  const caller = toBuffer(bytes);
  await withCanvas(async () => {
    const { load, received } = detachingLoader({ pages: ['', ''] });
    const ocr = await renderPdfPagesToImages(caller, { loadDocument: load, maxPages: 2 });
    assert.equal(ocr.images.length, 2);
    assert.equal(ocr.unavailable, false);
    assert.equal(received[0].byteLength, 0);
    assert.equal(caller.byteLength, bytes.byteLength, 'render must not detach the caller buffer');
    // The exact reported symptom must be gone:
    assert.doesNotThrow(() => new Uint8Array(caller));
  });
});

// --- page and character limits are preserved ------------------------------------------------

test('multipage PDF: every page is read in order and the document is not truncated', async () => {
  const bytes = multiPagePdfBytes(5, (page) => `PAGE-${String(page).padStart(3, '0')} body text for multipage coverage`);
  const result = await extractPdfText(bytes);
  assert.equal(result.pageCount, 5);
  assert.equal(result.pagesRead, 5);
  assert.equal(result.truncated, false);
  for (let page = 1; page <= 5; page += 1) {
    assert.match(result.text, new RegExp(`PAGE-00${page}`), `page ${page} text present`);
  }
  assert.ok(result.text.indexOf('PAGE-001') < result.text.indexOf('PAGE-005'), 'pages keep their order');
});

test('the 200-page extraction ceiling still holds after the fix', async () => {
  assert.equal(LIMITS.maxPdfPages, 200, 'the documented ceiling');
  const bytes = multiPagePdfBytes(201, (page) => (page === 201 ? 'PAGE-201 must never be read' : ''));
  const result = await extractPdfText(bytes);
  assert.equal(result.pageCount, 201);
  assert.equal(result.pagesRead, 200, 'page 201 is never loaded');
  assert.equal(result.truncated, true);
  assert.ok(!result.text.includes('PAGE-201'));
});

test('the 200-page ceiling also holds with a detaching loader', async () => {
  const bytes = multiPagePdfBytes(205);
  // eslint-disable-next-line no-unused-vars
  const pages = Array.from({ length: 205 }, () => '');
  const { load } = detachingLoader({ pages });
  const result = await extractPdfText(bytes, { loadDocument: load });
  assert.equal(result.pagesRead, 200);
  assert.equal(result.truncated, true);
});

test('per-document character ceiling is still enforced', async () => {
  const body = Array.from({ length: 200 }, (_, i) => `LINE-${String(i).padStart(3, '0')} ${'x'.repeat(40)}`);
  const bytes = multiPagePdfBytes(2, (page) => body.slice(page * 100 - 100, page * 100).join(' '));
  const result = await extractPdfText(bytes, { maxChars: 150 });
  assert.ok(result.text.length <= 220, `bounded text, got ${result.text.length}`);
  assert.equal(result.truncated, true);
});

test('scanned-PDF OCR still renders at most LIMITS.maxOcrPages pages', async () => {
  const bytes = samplePdfBytes('');
  await withCanvas(async () => {
    const { load } = detachingLoader({ pages: ['', '', '', '', '', ''] });
    const result = await processPdfDocument(pdfFile(bytes), { loadDocument: load, maxPages: LIMITS.maxOcrPages });
    assert.equal(LIMITS.maxOcrPages, 3);
    assert.equal(result.ocrImages.length, 3, 'exactly three pages, never more');
    assert.deepEqual(result.ocrImages.map((image) => image.page), [1, 2, 3]);
  });
});

// --- failure and cleanup --------------------------------------------------------------------

test('a failing load still destroys nothing it did not create and leaves the bytes usable', async () => {
  const bytes = samplePdfBytes('cleanup fixture with enough text to be a real document');
  const caller = toBuffer(bytes);
  let loads = 0;
  const load = async () => { loads += 1; throw new Error('Invalid PDF structure'); };

  await assert.rejects(() => extractPdfText(caller, { loadDocument: load }), /Invalid PDF structure/);
  assert.equal(loads, 1);
  assert.equal(caller.byteLength, bytes.byteLength, 'a failed load must not detach the caller bytes');
});

test('cleanup: every loaded document is destroyed, including after a failure', async () => {
  const bytes = samplePdfBytes('destroy bookkeeping');
  const destroyed = [];
  const makeDoc = (numPages, { failOnPage = false } = {}) => ({
    numPages,
    async getPage() {
      if (failOnPage) throw new Error('page could not be read');
      return { getTextContent: async () => ({ items: [{ str: 'text' }] }) };
    },
    async destroy() { destroyed.push(numPages); },
  });

  // success path
  await extractPdfText(bytes, { loadDocument: async () => makeDoc(1) });
  assert.equal(destroyed.length, 1);

  // failure inside the page loop
  await assert.rejects(
    () => extractPdfText(bytes, { loadDocument: async () => makeDoc(2, { failOnPage: true }) }),
    /page could not be read/,
  );
  assert.equal(destroyed.length, 2, 'destroy() still runs when page iteration throws');
});

test('cleanup: a destroy() that throws is tolerated and does not mask the result', async () => {
  const bytes = samplePdfBytes('destroy throws');
  const doc = {
    numPages: 1,
    async getPage() { return { getTextContent: async () => ({ items: [{ str: 'still readable text' }] }) }; },
    async destroy() { throw new Error('Worker was destroyed'); },
  };
  const result = await extractPdfText(bytes, { loadDocument: async () => doc });
  assert.match(result.text, /still readable text/);
});

test('processing failure: a scanned PDF that cannot be rendered reports OCR as unavailable', async () => {
  const bytes = samplePdfBytes('');
  // No `document` in this environment → the renderer reports it is unavailable instead of throwing.
  const result = await processPdfDocument(pdfFile(bytes));
  assert.equal(result.likelyScanned, true);
  assert.equal(result.ocrUnavailable, true);
  assert.deepEqual(result.ocrImages, []);
});

// --- sequential attachments -----------------------------------------------------------------

test('two PDFs processed one after another each keep their own bytes', async () => {
  const first = pdfFile(samplePdfBytes('alpha document text with plenty of readable content'));
  const second = pdfFile(samplePdfBytes('bravo document text with plenty of readable content'));

  const a = await processPdfDocument(first);
  const b = await processPdfDocument(second);

  assert.match(a.text, /alpha document/);
  assert.match(b.text, /bravo document/);
  assert.ok(!b.text.includes('alpha'), 'no bleed between attachments');
});

test('two PDFs whose files share one backing buffer do not detach each other', async () => {
  // Android can hand the WebView views into a pooled buffer; each attachment must own its bytes.
  const combined = new Uint8Array(samplePdfBytes('shared backing buffer one').byteLength * 2);
  const one = samplePdfBytes('shared backing buffer one');
  const two = samplePdfBytes('shared backing buffer two');
  combined.set(one, 0);
  combined.set(two, one.byteLength);
  const viewOne = new Uint8Array(combined.buffer, 0, one.byteLength);
  const viewTwo = new Uint8Array(combined.buffer, one.byteLength, two.byteLength);

  const a = await extractPdfText(viewOne);
  const b = await extractPdfText(viewTwo);

  assert.match(a.text, /shared backing buffer one/);
  assert.match(b.text, /shared backing buffer two/);
  assert.equal(combined.byteLength, one.byteLength * 2, 'the shared buffer is never detached');
});

test('extractDocumentText: the PDF branch is detachment-safe and non-PDF documents are unchanged', async () => {
  const bytes = samplePdfBytes('dispatched through extractDocumentText with real content');
  const pdf = await extractDocumentText(pdfFile(bytes));
  assert.match(pdf.text, /dispatched through extractDocumentText/);

  const text = await extractDocumentText({ name: 'notes.txt', type: 'text/plain', size: 11, text: async () => 'plain text' });
  assert.equal(text.text, 'plain text');
  assert.equal(text.likelyScanned, false);
});

// --- the real PDF.js, not just the simulation -----------------------------------------------

test('real PDF.js: the caller buffer is never detached (shipped code path)', async () => {
  const bytes = samplePdfBytes('Real PDF.js leaves our bytes alone and still extracts this text');
  const caller = toBuffer(bytes);

  const before = caller.byteLength;
  const result = await extractPdfText(caller);
  assert.match(result.text, /Real PDF.js leaves our bytes alone/);
  assert.equal(caller.byteLength, before, 'the shipped loader must not detach the caller buffer');
  assert.match(new TextDecoder().decode(caller), /^%PDF-1\.4/);
});

test('real PDF.js: a text PDF loads once, and a scanned PDF still reaches the OCR pass', async () => {
  const textPdf = pdfFile(samplePdfBytes('A genuine text layer with comfortably enough characters'));
  const processed = await processPdfDocument(textPdf);
  assert.equal(processed.likelyScanned, false);
  assert.match(processed.text, /genuine text layer/);

  // A scanned PDF through the real library: the OCR pass must not throw the detached-buffer error.
  await withCanvas(async () => {
    const scanned = pdfFile(samplePdfBytes(''));
    const result = await processPdfDocument(scanned);
    assert.equal(result.likelyScanned, true);
    assert.equal(result.ocrUnavailable, false, 'pages were rendered through the real PDF.js');
    assert.ok(result.ocrImages.length >= 1);
    assert.match(result.ocrImages[0].data, /^data:image\/jpeg;base64,/);
  });
});

// --- the classification boundary that decided which PDFs failed ------------------------------

test('a short-text PDF is classified as scanned and therefore takes a second load', async () => {
  // This is the exact shape of the reported failure: the first load succeeds (text is read), the
  // document is then classified as scanned because the text layer is nearly empty, and the OCR
  // pass runs a second PDF.js load — which the old single-buffer pipeline could not survive.
  const bytes = samplePdfBytes('Short note');
  await withCanvas(async () => {
    const { load, received } = detachingLoader({ pages: ['Short note'] });
    const report = createCopyReport();
    const result = await processPdfDocument(pdfFile(bytes), { loadDocument: load, report });

    assert.equal(result.likelyScanned, true, 'fewer than 25 non-space characters means scanned');
    assert.equal(received.length, 2, 'text pass + OCR pass');
    for (const copy of received) assert.equal(copy.byteLength, 0, 'each load detached its own copy');
    assert.deepEqual(report.stages(), ['snapshot', 'transfer', 'transfer']);
  });
});

test('a long-text PDF takes exactly one load and never reaches the OCR pass', async () => {
  const bytes = samplePdfBytes('This document has a long text layer, comfortably over twenty five characters');
  await withCanvas(async () => {
    const { load, received } = detachingLoader({ pages: ['This document has a long text layer, comfortably over twenty five characters'] });
    const result = await processPdfDocument(pdfFile(bytes), { loadDocument: load });
    assert.equal(result.likelyScanned, false);
    assert.equal(received.length, 1, 'no OCR load for a text PDF — the conditional reuse is not reached');
    assert.equal(result.ocrImages, undefined, 'no OCR images are produced');
  });
});

test('the caller file can be re-read after processing, whatever the classification', async () => {
  // processPdfDocument never hands the caller's own buffer to PDF.js, so the File stays readable —
  // which is what makes retry-after-failure and sequential attachments safe.
  for (const text of ['A long text layer with plenty of readable characters in it', '']) {
    const bytes = samplePdfBytes(text);
    let reads = 0;
    const file = {
      name: 'x.pdf', type: 'application/pdf', size: bytes.byteLength,
      arrayBuffer: async () => { reads += 1; return toBuffer(bytes); },
    };
    await withCanvas(() => processPdfDocument(file));
    assert.equal(reads, 1, 'the file is read once per processing run');
    assert.equal(bytes.byteLength, samplePdfBytes(text).byteLength, 'the source bytes are untouched');
    assert.match(new TextDecoder().decode(bytes), /^%PDF-1\.4/);
  }
});
