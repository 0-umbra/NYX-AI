/**
 * What the conversation shows when a request fails, and what is recorded about the on-device
 * attachment stages. Both are user-visible behaviour that the image-attachment bug report turned
 * on: the cause must be shown (not hidden behind "check your connection"), while internal errors
 * must stay hidden.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { initChat } from '../../src/js/chat.js';
import { createStore } from '../../src/js/store.js';
import { createStorage } from '../../src/js/storage.js';
import { createAttachmentDiagnostics } from '../../src/js/attachments.js';

const HTML = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const GENERIC = 'The reply couldn’t be completed. Check your connection and try again.';

class FakeLocalStorage {
  #data = new Map();
  get length() { return this.#data.size; }
  key(i) { return [...this.#data.keys()][i] ?? null; }
  getItem(k) { return this.#data.has(k) ? this.#data.get(k) : null; }
  setItem(k, v) { this.#data.set(k, String(v)); }
  removeItem(k) { this.#data.delete(k); }
}

function setup({ diagnostics = null } = {}) {
  const dom = new JSDOM(HTML, { url: 'https://example.test/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.CSS = { escape: (s) => s };
  dom.window.HTMLElement.prototype.scrollTo = function scrollTo({ top } = {}) { this.scrollTop = top ?? 0; };

  const storage = createStorage(new FakeLocalStorage());
  const store = createStore(storage);
  const chat = initChat({ store, getModelId: () => 'free', storage, diagnostics });
  const settle = async (promise) => { await promise; await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
  const send = async (text) => {
    document.getElementById('composer-input').value = text;
    await settle(chat.send());
  };
  const notices = () => [...document.querySelectorAll('.msg-system')].map((node) => node.textContent);
  return { dom, chat, store, send, notices };
}

test('a classified failure is shown in the conversation instead of the generic message', async () => {
  const { dom, chat, send, notices } = setup();
  chat.setTransport(async function* () {
    const error = new Error('That image is too large to analyse. Try a smaller one.');
    error.userFacing = true;
    throw error;
  });
  await send('What is in this image?');
  const shown = notices().join('\n');
  assert.match(shown, /too large to analyse/);
  assert.doesNotMatch(shown, /Check your connection/);
  dom.window.close();
});

test('an unclassified internal error keeps the generic message and is never displayed', async () => {
  const { dom, chat, send, notices } = setup();
  chat.setTransport(async function* () { throw new Error('TypeError: x is not a function at bundle.js:1'); });
  await send('anything');
  const shown = notices().join('\n');
  assert.match(shown, /couldn’t be completed/);
  assert.doesNotMatch(shown, /bundle\.js|x is not a function/);
  dom.window.close();
});

test('a raw network failure keeps the generic connection message', async () => {
  const { dom, chat, send, notices } = setup();
  chat.setTransport(async function* () { throw new TypeError('Failed to fetch'); });
  await send('anything');
  assert.match(notices().join('\n'), /couldn’t be completed/);
  dom.window.close();
});

test('the quota, session and rate-limit messages are shown exactly as the transport words them', async () => {
  for (const message of [
    'Your session has expired. Please sign in again.',
    'Too many requests. Please wait a moment and try again.',
    'The free daily AI quota is exhausted. It resets at 00:00 UTC.',
  ]) {
    const { dom, chat, send, notices } = setup();
    chat.setTransport(async function* () {
      const error = new Error(message);
      error.userFacing = true;
      throw error;
    });
    await send('hi');
    assert.match(notices().join('\n'), new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    dom.window.close();
  }
});

test('a plain Error (no userFacing flag) is never displayed, even with a friendly-looking message', async () => {
  const { dom, chat, send, notices } = setup();
  // A transport stub, an injected helper or an internal module can throw anything. Only the real
  // transport marks an error as safe to show, so an unmarked message is never presented as the
  // explanation — the impact is reported generically instead.
  chat.setTransport(async function* () { throw new Error('That image is too large to analyse. Try a smaller one.'); });
  await send('hi');
  const shown = notices().join('\n');
  assert.equal(shown.trim(), GENERIC, 'the generic message is shown');
  assert.ok(!shown.includes('too large'), 'the unmarked error text is not shown');
  dom.window.close();
});

// --- on-device attachment diagnostics ---------------------------------------

test('createAttachmentDiagnostics: records stage, category and safe details only', () => {
  const records = [];
  const diagnostics = createAttachmentDiagnostics({ emit: (record) => records.push(record) });
  diagnostics.record('image.decode', 'DECODE_FAILED');
  diagnostics.record('transport.attachments', 'TOO_LARGE', { status: 413 });
  assert.deepEqual(records, [
    { event: 'nyx.attachment', stage: 'image.decode', category: 'DECODE_FAILED' },
    { event: 'nyx.attachment', stage: 'transport.attachments', category: 'TOO_LARGE', status: 413 },
  ]);
});

test('createAttachmentDiagnostics: a failing sink never breaks attachment processing', () => {
  const diagnostics = createAttachmentDiagnostics({ emit: () => { throw new Error('sink down'); } });
  assert.doesNotThrow(() => diagnostics.record('image.decode', 'DECODE_FAILED'));
});

test('createAttachmentDiagnostics: the default sink writes structured data, not free text', () => {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args);
  try {
    createAttachmentDiagnostics().record('document.process', 'PROCESSING_FAILED');
  } finally {
    console.warn = original;
  }
  const record = lines.at(-1).at(-1);
  assert.equal(record.event, 'nyx.attachment');
  assert.equal(record.stage, 'document.process');
});
