import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../../src/js/storage.js';
import { createStore, groupByDate, titleFrom, sanitize, DEFAULT_TITLE } from '../../src/js/store.js';
import { createPrefs, normalizePrefs, DEFAULT_PREFS } from '../../src/js/settings.js';
import { parseHash, ROUTES, hashFor } from '../../src/js/router.js';
import { MODELS, getModel, isModelId, DEFAULT_MODEL_ID } from '../../src/js/models.js';
import { escapeHtml, formatBytes, plural, uid } from '../../src/js/util.js';
import { LIMITS, isBackendConfigured, BACKEND, SUPABASE } from '../../src/js/config.js';

class FakeLocalStorage {
  #d = new Map();
  get length() { return this.#d.size; }
  key(i) { return [...this.#d.keys()][i] ?? null; }
  getItem(k) { return this.#d.has(k) ? this.#d.get(k) : null; }
  setItem(k, v) { this.#d.set(k, String(v)); }
  removeItem(k) { this.#d.delete(k); }
}
const throwing = { setItem() { throw new Error('blocked'); }, removeItem() {}, getItem() { throw new Error('blocked'); }, key() { return null; }, length: 0 };

test('storage: round-trips JSON, falls back on corrupt data, clears only its namespace', () => {
  const ls = new FakeLocalStorage();
  ls.setItem('other', 'keep');
  const s = createStorage(ls);
  assert.equal(s.persistent, true);
  assert.equal(s.set('a', { x: 1 }), true);
  assert.deepEqual(s.get('a'), { x: 1 });
  ls.setItem('nyx.bad', '{not json');
  assert.equal(s.get('bad', 'fallback'), 'fallback');
  s.clear();
  assert.equal(s.get('a'), null);
  assert.equal(ls.getItem('other'), 'keep');
});

test('storage: works (in memory) when localStorage is blocked or missing', () => {
  for (const backend of [throwing, null, undefined]) {
    const s = createStorage(backend);
    assert.equal(s.persistent, false);
    s.set('k', [1, 2]);
    assert.deepEqual(s.get('k'), [1, 2]);
  }
});

test('store: create, add messages, title from first user message, search, delete', () => {
  const st = createStorage(new FakeLocalStorage());
  const store = createStore(st);
  assert.equal(store.count(), 0);
  const c = store.create('pro');
  assert.equal(c.title, DEFAULT_TITLE);
  store.addMessage(c.id, { role: 'user', content: 'Plan my trip to Lisbon' });
  store.addMessage(c.id, { role: 'system', content: 'AI backend not connected', kind: 'backend-offline' });
  assert.equal(store.get(c.id).title, 'Plan my trip to Lisbon');
  assert.equal(store.get(c.id).messages.length, 2);
  assert.equal(store.search('lisbon').length, 1);
  assert.equal(store.search('zzz').length, 0);
  assert.equal(store.search('').length, 1);
  // persisted and reloaded
  assert.equal(createStore(st).count(), 1);
  store.remove(c.id);
  assert.equal(store.count(), 0);
  assert.equal(createStore(st).count(), 0);
});

test('store: ignores invalid input and sanitises corrupt saved data', () => {
  const store = createStore(createStorage(new FakeLocalStorage()));
  assert.equal(store.addMessage('missing', { role: 'user', content: 'x' }), null);
  const c = store.create();
  assert.equal(store.addMessage(c.id, { role: 'hacker', content: 'x' }), null);
  assert.deepEqual(sanitize('nope'), []);
  assert.equal(sanitize([{ id: 1 }, { id: 'a', messages: [{ id: 'm', role: 'user', content: 'ok' }, { id: 'n', role: 'bad', content: 'x' }] }])[0].messages.length, 1);
});

test('store: attachments keep metadata only; message cap enforced', () => {
  const store = createStore(createStorage(new FakeLocalStorage()));
  const c = store.create();
  const m = store.addMessage(c.id, { role: 'user', content: '', attachments: [{ name: 'a.pdf', size: 5, type: 'application/pdf', file: { big: true } }] });
  assert.deepEqual(m.attachments, [{ name: 'a.pdf', size: 5, type: 'application/pdf' }]);
  assert.equal(store.get(c.id).title, 'a.pdf');
  for (let i = 0; i < LIMITS.maxMessagesPerConversation + 5; i++) store.addMessage(c.id, { role: 'user', content: String(i) });
  assert.equal(store.get(c.id).messages.length, LIMITS.maxMessagesPerConversation);
});

test('store: conversation cap enforced', () => {
  const store = createStore(createStorage(new FakeLocalStorage()));
  for (let i = 0; i < LIMITS.maxConversations + 3; i++) store.create();
  assert.equal(store.count(), LIMITS.maxConversations);
});

test('groupByDate buckets conversations', () => {
  const now = new Date(2026, 10, 3, 15, 0).getTime();
  const day = 86_400_000;
  const mk = (id, t) => ({ id, updatedAt: t });
  const groups = groupByDate([mk('a', now - 1000), mk('b', now - day), mk('c', now - 4 * day), mk('d', now - 30 * day)], now);
  assert.deepEqual(groups.map((g) => g.label), ['Today', 'Yesterday', 'Previous 7 days', 'Older']);
  assert.deepEqual(groupByDate([], now), []);
});

test('titleFrom trims and truncates', () => {
  assert.equal(titleFrom('   '), DEFAULT_TITLE);
  assert.equal(titleFrom('a   b\n c'), 'a b c');
  assert.ok(titleFrom('x'.repeat(100)).length <= 48);
});

test('prefs: defaults, validation, persistence, reset', () => {
  const st = createStorage(new FakeLocalStorage());
  const prefs = createPrefs(st);
  assert.deepEqual(prefs.all(), DEFAULT_PREFS);
  let notified = 0;
  prefs.subscribe(() => notified++);
  prefs.set('accent', 'blue');
  prefs.set('accent', 'pink'); // invalid -> falls back to default valid value
  assert.equal(prefs.get('accent'), 'violet');
  prefs.set('accent', 'blue');
  prefs.set('memory.autoSave', true);
  prefs.set('displayName', '  Ada  ');
  assert.equal(prefs.get('displayName'), 'Ada');
  assert.equal(createPrefs(st).get('memory.autoSave'), true);
  assert.equal(notified, 5);
  prefs.reset();
  assert.deepEqual(prefs.all(), DEFAULT_PREFS);
  assert.deepEqual(normalizePrefs({ theme: 'x', textSize: 'lg', memory: { enabled: 'yes' } }).memory, DEFAULT_PREFS.memory);
  assert.equal(normalizePrefs({ displayName: 'x'.repeat(99) }).displayName.length, 32);
});

test('router: parses hashes and every route has a valid parent chain ending at chat', () => {
  assert.equal(parseHash(''), 'chat');
  assert.equal(parseHash('#/settings'), 'settings');
  assert.equal(parseHash('#settings/'), 'settings');
  assert.equal(parseHash('#/nope'), 'chat');
  assert.equal(parseHash('#/constructor'), 'chat');
  assert.equal(hashFor('about'), '#/about');
  for (const name of Object.keys(ROUTES)) {
    let cur = name; let hops = 0;
    while (ROUTES[cur].parent) { cur = ROUTES[cur].parent; assert.ok(ROUTES[cur], `${name} parent exists`); assert.ok(++hops < 5, 'no cycles'); }
    assert.equal(cur, 'chat');
  }
});

test('models: FREE / PRO / MAX with descriptions', () => {
  assert.deepEqual(MODELS.map((m) => m.name), ['FREE', 'PRO', 'MAX']);
  for (const m of MODELS) { assert.ok(m.description.length > 10); assert.ok(m.tagline); assert.ok(m.traits.length >= 2); }
  assert.equal(getModel('nope').id, DEFAULT_MODEL_ID);
  assert.equal(isModelId('max'), true);
  assert.equal(isModelId('gpt'), false);
});

test('util + config', () => {
  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(plural(1, 'file'), '1 file');
  assert.equal(plural(2, 'file'), '2 files');
  assert.notEqual(uid(), uid());
  assert.equal(isBackendConfigured(), false);
  assert.equal(BACKEND.baseUrl, null);
  assert.deepEqual(SUPABASE, { url: null, anonKey: null });
});
