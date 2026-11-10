/**
 * Regression tests for the PDF.js ArrayBuffer-detachment bug.
 *
 * The bug: `getDocument()` hands the caller's ArrayBuffer to PDF.js's Worker as a *transferable*,
 * which permanently detaches it. The old pipeline extracted text with the only buffer it had and
 * then reused that same (now detached) buffer to render scanned pages, so every PDF failed with
 * "Cannot perform Construct on a detached ArrayBuffer" — after the text layer had already been
 * read successfully, which is why text PDFs failed too.
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

test('withPdfBytes: hands out independent copies and never exposes the snapshot', () => {
  const bytes = samplePdfBytes('hello');
  const arena = withPdfBytes(bytes);
  assert.equal(arena.length, bytes.byteLength);

  const a = arena.fresh();
  const b = arena.fresh();
  assert.notEqual(a, b, 'each load gets its own copy');
  assert.notEqual(a.buffer, b.buffer, 'each load gets its own ArrayBuffer');
  assert.equal(a.byteLength, bytes.byteLength);

  // Detaching one copy (as PDF.js does) leaves the arena and every later copy intact.
  structuredClone(a.buffer, { transfer: [a.buffer] });
  assert.equal(a.byteLength, 0);
  const c = arena.fresh();
  assert.equal(c.byteLength, bytes.byteLength, 'bytes survive a detached transfer');
  assert.deepEqual([...c], [...bytes], 'content is byte-identical');
  assert.equal(arena.isDetached(), false, 'the snapshot itself was never handed out');
});

test('withPdfBytes: accepts ArrayBuffer, any TypedArray view and Buffer', () => {
  const bytes = samplePdfBytes('view tolerance');
  const view = new Uint8Array(10 + bytes.byteLength);
  view.set(bytes, 5); // deliberately offset, as a pooled Buffer would be
  const offsetView = new Uint8Array(view.buffer, 5, bytes.byteLength);

  for (const input of [toBuffer(bytes), bytes, offsetView, Buffer.from(bytes)]) {
    const arena = withPdfBytes(input);
    assert.deepEqual([...arena.fresh()], [...bytes], `input ${input.constructor.name}`);
  }
});

test('withPdfBytes: copies exactly once per PDF (no extra copies for memory pressure)', () => {
  // Two loads must be the only copies; the snapshot itself is one more. Anything beyond that
  // would multiply a 10 MB PDF on a low-end Android device.
  const bytes = samplePdfBytes('budget');
  const arena = withPdfBytes(bytes);
  const size = bytes.byteLength;
  assert.equal(arena.length, size);
  assert.equal(size, bytes.byteLength, 'the caller input is untouched by snapshotting');
});

// --- the reported bug, reproduced and fixed ------------------------------------------------

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

test('real PDF.js: processPdfDocument leaves the file readable and a scanned PDF reaches OCR', async () => {
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
