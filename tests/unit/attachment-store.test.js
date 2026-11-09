/** Store persistence of attachment metadata + bounded extracted content. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, sanitizeAttachment } from '../../src/js/store.js';
import { createStorage } from '../../src/js/storage.js';

class FakeLocalStorage {
  #data = new Map();
  get length() { return this.#data.size; }
  key(i) { return [...this.#data.keys()][i] ?? null; }
  getItem(k) { return this.#data.has(k) ? this.#data.get(k) : null; }
  setItem(k, v) { this.#data.set(k, String(v)); }
  removeItem(k) { this.#data.delete(k); }
}

const fresh = () => createStorage(new FakeLocalStorage());

test('sanitizeAttachment: keeps metadata and bounds extracted content', () => {
  const a = sanitizeAttachment({
    name: 'x.pdf', size: 10.7, type: 'application/pdf', kind: 'document',
    analysis: 'y'.repeat(5000), extractedText: 'z'.repeat(9000), pageCount: 12,
    truncated: true, scanned: true, ocrPages: 3,
    thumb: `data:image/jpeg;base64,${'A'.repeat(100)}`,
  });
  assert.equal(a.size, 10);
  assert.equal(a.analysis.length, 1600);
  assert.equal(a.extractedText.length, 4000);
  assert.equal(a.pageCount, 12);
  assert.equal(a.truncated, true);
  assert.equal(a.scanned, true);
  assert.equal(a.ocrPages, 3);
  assert.ok(a.thumb.startsWith('data:image/'));
});

test('sanitizeAttachment: rejects junk and strips oversized thumbs', () => {
  assert.equal(sanitizeAttachment(null), null);
  assert.equal(sanitizeAttachment({}), null); // no usable name
  const a = sanitizeAttachment({ name: 'ok.png', size: 1, type: 'image/png', thumb: 'data:image/jpeg;base64,' + 'A'.repeat(9000) });
  assert.equal(a.thumb, undefined, 'oversized thumbnails are not persisted');
});

test('store: addMessage persists attachment analyses; updateMessage merges later', () => {
  const store = createStore(fresh());
  const conv = store.create('free');
  const msg = store.addMessage(conv.id, {
    role: 'user', content: 'Summarise this',
    attachments: [{ name: 'a.pdf', size: 100, type: 'application/pdf', kind: 'document', extractedText: 'the doc body' }],
  });
  assert.equal(msg.attachments[0].extractedText, 'the doc body');

  store.updateMessage(conv.id, msg.id, {
    attachments: [{ ...msg.attachments[0], analysis: 'ignored for documents', extractedText: 'merged body' }],
  });
  const after = store.get(conv.id).messages[0];
  assert.equal(after.attachments[0].extractedText, 'merged body');
});

test('store: updateMessage sanitizes attachments it persists', () => {
  const store = createStore(fresh());
  const conv = store.create('free');
  const msg = store.addMessage(conv.id, { role: 'user', content: 'hi', attachments: [] });
  store.updateMessage(conv.id, msg.id, {
    attachments: [{ name: 'huge.pdf', size: 1, type: 'application/pdf', kind: 'document', extractedText: 'q'.repeat(9000) }],
  });
  const after = store.get(conv.id).messages[0];
  assert.equal(after.attachments[0].extractedText.length, 4000);
});

test('store: originals are never persisted — only metadata and extracted content', () => {
  const store = createStore(fresh());
  const conv = store.create('free');
  const msg = store.addMessage(conv.id, {
    role: 'user', content: 'look',
    attachments: [{ name: 'secret.png', size: 5, type: 'image/png', kind: 'image', file: { buffer: 'origin' }, data: 'data:image/png;base64,AAAA', analysis: 'a cat' }],
  });
  const persisted = msg.attachments[0];
  assert.equal(persisted.file, undefined);
  assert.equal(persisted.data, undefined, 'originals (data URIs) must not be stored');
  assert.equal(persisted.analysis, 'a cat');
});

test('store: sanitize() rehydrates persisted messages with bounded attachments', () => {
  const storage = fresh();
  storage.set('conversations', [{
    id: 'c1', title: 'Old', model: 'free', createdAt: 1, updatedAt: 2,
    messages: [
      { id: 'm1', role: 'user', content: 'hi', ts: 1, attachments: [{ name: 'x.pdf', size: 1, type: 'application/pdf', kind: 'document', extractedText: 'e'.repeat(9999) }] },
      { id: 'm2', role: 'user', content: 'bare', ts: 2, attachments: [{ name: 'bare.png', size: 1, type: 'image/png' }] },
    ],
  }]);
  const store = createStore(storage);
  const conv = store.get('c1');
  assert.equal(conv.messages[0].attachments[0].extractedText.length, 4000);
  assert.deepEqual(conv.messages[1].attachments, [{ name: 'bare.png', size: 1, type: 'image/png' }]);
});
