/**
 * Composer integration tests for the attachment pipeline (jsdom). Document flows run end-to-end:
 * attach → on-device extraction → chip status → send → wire payload → stored analysis metadata →
 * follow-up history. Image decode needs canvas/createImageBitmap (absent in jsdom), so the
 * image path is covered by tests/unit/attachments.test.js (logic), tests/e2e (real Chromium)
 * and the backend suite (vision endpoint).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { initChat } from '../../src/js/chat.js';
import { createStore } from '../../src/js/store.js';
import { createStorage } from '../../src/js/storage.js';

const HTML = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

class FakeLocalStorage {
  #data = new Map();
  get length() { return this.#data.size; }
  key(i) { return [...this.#data.keys()][i] ?? null; }
  getItem(k) { return this.#data.has(k) ? this.#data.get(k) : null; }
  setItem(k, v) { this.#data.set(k, String(v)); }
  removeItem(k) { this.#data.delete(k); }
}

function setupDom() {
  const dom = new JSDOM(HTML, { url: 'https://example.test/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.CSS = { escape: (s) => s };
  dom.window.HTMLElement.prototype.scrollTo = function scrollTo({ top } = {}) { this.scrollTop = top ?? 0; };
  return dom;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (promise) => { await promise; await tick(); await tick(); };
const waitFor = async (predicate, { timeout = 5000, step = 5 } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, step));
  }
};

function setupChat({ storage = createStorage(new FakeLocalStorage()), dom = setupDom() } = {}) {
  const store = createStore(storage);
  const sent = [];
  const chat = initChat({ store, storage, getModelId: () => 'free' });
  chat.setTransport(async function* transport(request) {
    sent.push(request);
    yield `reply-${sent.length}`;
  });
  const attach = (inputId, files) => {
    const input = document.getElementById(inputId);
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new dom.window.Event('change'));
  };
  const send = async (text) => {
    document.getElementById('composer-input').value = text;
    await settle(chat.send());
  };
  return { dom, store, chat, sent, attach, send };
}

const readyCount = () => document.querySelectorAll('.attachment-status.is-ok').length;
const chips = () => [...document.querySelectorAll('.attachment')];

test('document flow: attach → extract → chip shows ready → send → wire payload carries text, not the file', async () => {
  const { dom, store, sent, attach, send } = setupChat();
  const file = new dom.window.File(['Revenue grew 12% year over year.'], 'report.txt', { type: 'text/plain' });
  attach('file-input', [file]);
  await waitFor(() => readyCount() === 1);
  assert.match(chips()[0].textContent, /Text extracted/);
  assert.match(chips()[0].textContent, /TXT/);

  await send('Summarise this document.');
  assert.equal(sent.length, 1);
  const wire = sent[0].attachments;
  assert.equal(wire.length, 1);
  assert.equal(wire[0].kind, 'document');
  assert.equal(wire[0].name, 'report.txt');
  assert.match(wire[0].text, /Revenue grew 12%/);
  assert.equal(wire[0].data, undefined, 'the original file is never sent');

  // The stored message keeps metadata + extracted text (never the original).
  const conv = store.get(chatActive(store));
  const stored = conv.messages.find((m) => m.role === 'user');
  assert.equal(stored.attachments[0].name, 'report.txt');
  assert.equal(stored.attachments[0].extractedText, 'Revenue grew 12% year over year.');
  assert.equal(stored.attachments[0].data, undefined);
  dom.window.close();
});

test('follow-up: previously analysed documents are folded into the next request context', async () => {
  const { dom, sent, attach, send } = setupChat();
  const file = new dom.window.File(['churn fell to 3%'], 'metrics.txt', { type: 'text/plain' });
  attach('file-input', [file]);
  await waitFor(() => readyCount() === 1);
  await send('Summarise this.');
  await send('What was the churn figure?');

  const followUp = sent.at(-1).messages;
  const turn = followUp.find((m) => m.role === 'user' && /Summarise this/.test(m.content));
  assert.match(turn.content, /Attached document "metrics\.txt": churn fell to 3%/);
  dom.window.close();
});

test('multiple attachments: several documents are sent in one message', async () => {
  const { dom, sent, attach, send } = setupChat();
  attach('file-input', [
    new dom.window.File(['alpha body'], 'a.txt', { type: 'text/plain' }),
    new dom.window.File(['beta body'], 'b.csv', { type: 'text/csv' }),
  ]);
  await waitFor(() => readyCount() === 2);
  await send('Compare them.');
  assert.equal(sent[0].attachments.length, 2);
  assert.deepEqual(sent[0].attachments.map((a) => a.name), ['a.txt', 'b.csv']);
  dom.window.close();
});

test('remove: a chip can be removed before sending', async () => {
  const { dom, sent, attach, send } = setupChat();
  attach('file-input', [
    new dom.window.File(['keep me'], 'keep.txt', { type: 'text/plain' }),
    new dom.window.File(['drop me'], 'drop.txt', { type: 'text/plain' }),
  ]);
  await waitFor(() => readyCount() === 2);
  document.querySelector('[data-remove-file="1"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(chips().length, 1);
  await send('Read this.');
  assert.deepEqual(sent[0].attachments.map((a) => a.name), ['keep.txt']);
  dom.window.close();
});

test('failed processing: a broken PDF shows an error with a retry control; send is blocked until resolved', async () => {
  const { dom, sent, attach, send } = setupChat();
  const broken = new dom.window.File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], 'broken.pdf', { type: 'application/pdf' });
  attach('file-input', [broken]);
  await waitFor(() => document.querySelector('.attachment.is-error'));
  assert.match(document.querySelector('.attachment-status.is-error').textContent, /.+/);
  assert.ok(document.querySelector('[data-retry-file="0"]'), 'retry control is shown');

  await send('Summarise this.');
  assert.equal(sent.length, 0, 'a failed attachment blocks the send instead of vanishing silently');

  // Retrying re-runs processing (and fails again deterministically for this fixture).
  document.querySelector('[data-retry-file="0"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await waitFor(() => document.querySelector('.attachment.is-error'));
  assert.ok(document.querySelector('[data-retry-file="0"]'));

  // Removing it unblocks sending.
  document.querySelector('[data-remove-file="0"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(chips().length, 0);
  await send('Hello without files.');
  assert.equal(sent.length, 1);
  dom.window.close();
});

test('an unsupported file type is rejected with a clear message and never reaches the model', async () => {
  const { dom, sent, attach, send } = setupChat();
  attach('file-input', [new dom.window.File(['MZ'], 'evil.exe', { type: 'application/x-msdownload' })]);
  await tick(); await tick();
  assert.equal(chips().length, 0, 'unsupported files are rejected at intake');
  assert.match(document.getElementById('toast').textContent, /isn’t supported/);
  await send('hi');
  assert.equal(sent[0].attachments, undefined);
  dom.window.close();
});

function chatActive(store) {
  const list = store.list();
  assert.equal(list.length, 1);
  return list[0].id;
}
