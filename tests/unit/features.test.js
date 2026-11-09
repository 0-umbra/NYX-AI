import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { initAuth } from '../../src/js/auth.js';
import { initModels } from '../../src/js/models.js';
import { initSettings, createPrefs, THEME_COLOR, THEME_LABELS } from '../../src/js/settings.js';
import { initSidebar } from '../../src/js/sidebar.js';
import { createStore } from '../../src/js/store.js';
import { createStorage } from '../../src/js/storage.js';
import { createTransport } from '../../src/js/transport.js';
import { revealText } from '../../src/js/reveal.js';
import { renderMarkdown } from '../../src/js/markdown.js';

function setup() {
  const dom = new JSDOM(readFileSync(new URL('../../index.html', import.meta.url), 'utf8'), { url: 'https://example.test/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function (v = '') { this.returnValue = v; this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  return dom;
}
const click = (id) => document.getElementById(id).click();
const tick = () => new Promise((r) => setTimeout(r, 0));

test('auth gate waits for restoration, supports login, signup, validation and logout', async () => {
  const dom = setup(); let notify; let called = []; let routes = [];
  const user = { email: 'a@example.com' };
  const services = {
    observe: (fn) => { notify = fn; },
    signIn: async (...args) => { called.push(['login', ...args]); notify(user); },
    create: async (...args) => { called.push(['create', ...args]); notify(user); },
    reset: async () => {}, logout: async () => notify(null),
  };
  initAuth({ prefs: { get: () => '' }, onSession: (u) => routes.push(u), services });
  assert.equal(document.getElementById('app').hidden, true);
  assert.equal(document.getElementById('auth-content').hidden, true);
  notify(user); // persisted Firebase session
  assert.equal(document.getElementById('auth-screen').hidden, true);
  assert.equal(document.getElementById('app').hidden, false);
  click('account-logout'); await tick();
  assert.equal(document.getElementById('app').hidden, true);
  assert.equal(document.getElementById('auth-screen').hidden, false);
  const email = document.getElementById('auth-email'); const password = document.getElementById('auth-password');
  const form = document.getElementById('auth-form');
  form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  assert.match(document.getElementById('auth-error').textContent, /email/i);
  email.value = 'a@example.com'; password.value = '123'; click('auth-create-tab');
  form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  assert.match(document.getElementById('auth-error').textContent, /6 characters/);
  click('auth-visibility'); assert.equal(password.type, 'text');
  password.value = '123456'; form.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await tick();
  assert.deepEqual(called[0], ['create', 'a@example.com', '123456']);
  notify(null); click('auth-login-tab'); password.value = 'secret';
  form.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await tick();
  assert.deepEqual(called[1], ['login', 'a@example.com', 'secret']);
  assert.equal(routes.at(-1), user);
  dom.window.close();
});

test('rename, pin, search, new chat and delete persist and interact', async () => {
  const dom = setup(); const storage = createStorage(dom.window.localStorage); const store = createStore(storage);
  const a = store.create(); store.addMessage(a.id, { role: 'user', content: 'first message' });
  const b = store.create(); store.addMessage(b.id, { role: 'user', content: 'second message' });
  let active = b.id; let newCount = 0;
  const chat = { get activeId() { return active; }, open(id) { active = id; }, newChat() { active = null; newCount++; }, subscribe() {} };
  initSidebar({ store, chat, router: { current: 'chat', go() {} }, storage });
  document.querySelector(`[data-pin="${a.id}"]`).click();
  assert.equal(document.querySelector('.conv-group-label').textContent, 'Pinned');
  document.querySelector(`[data-rename="${a.id}"]`).click();
  document.getElementById('rename-input').value = 'Renamed chat';
  document.getElementById('rename-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  assert.equal(store.get(a.id).title, 'Renamed chat');
  let reloaded = createStore(storage); assert.equal(reloaded.get(a.id).pinned, true); assert.equal(reloaded.get(a.id).title, 'Renamed chat');
  const search = document.getElementById('sidebar-search'); search.value = 'first message'; search.dispatchEvent(new dom.window.Event('input'));
  assert.equal(document.querySelectorAll('.conv-open').length, 1);
  assert.equal(document.querySelector('.conv-open').textContent, 'Renamed chat');
  document.querySelector(`[data-pin="${a.id}"]`).click(); assert.equal(createStore(storage).get(a.id).pinned, false);
  search.value = ''; search.dispatchEvent(new dom.window.Event('input'));
  click('new-chat-btn'); assert.equal(newCount, 1);
  document.querySelector(`[data-open="${b.id}"]`).click(); assert.equal(active, b.id);
  document.querySelector(`[data-del="${b.id}"]`).click(); document.getElementById('confirm-dialog').close('ok'); await tick();
  assert.equal(store.get(b.id), null); assert.equal(newCount, 2); assert.equal(createStore(storage).get(a.id).messages[0].content, 'first message');
  dom.window.close();
});

test('locked models remain unselectable and cannot invoke token or network; FREE keeps request format', async () => {
  const dom = setup(); const storage = createStorage(dom.window.localStorage); storage.set('model', 'max');
  const models = initModels({ storage }); assert.equal(models.id, 'free');
  document.querySelector('[data-value="pro"]').click(); assert.equal(models.id, 'free');
  models.set('max'); assert.equal(models.id, 'free');
  let tokens = 0; let requests = [];
  const deps = { getToken: async () => { tokens++; return 'test'; }, fetchRequest: async (...args) => { requests.push(args); return new Response(JSON.stringify({ reply: 'Hello' }), { status: 200 }); } };
  const args = { conversationId: 'abc', messages: [{ role: 'user', content: 'Hi' }], model: 'pro' };
  for (const model of ['pro', 'max']) await assert.rejects(async () => { for await (const _ of createTransport({ ...args, model }, deps)) {} }, /not available/);
  assert.equal(tokens, 0); assert.equal(requests.length, 0);
  const result = []; for await (const chunk of createTransport({ ...args, model: 'free' }, deps)) result.push(chunk);
  assert.deepEqual(result, ['Hello']); assert.equal(tokens, 1); assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0][1].body), { conversationId: 'abc', model: 'free', messages: args.messages });
  assert.equal(requests[0][1].headers.Authorization, 'Bearer test');
  dom.window.close();
});

test('reveal is progressive and preserves plain text, markdown, code and cancellation', async () => {
  for (const text of ['Hello world 🌌', '**Bold**\n\n- one\n- two', '```js\nconst x = 1;\n```']) {
    let current = ''; const snapshots = [];
    await revealText(text, { delay: 1, maxDuration: 100, onText: (part) => { current += part; snapshots.push(current); renderMarkdown(current); } });
    assert.ok(snapshots.length > 1); assert.notEqual(snapshots[0], text);
    assert.equal(current, text); assert.equal(renderMarkdown(current), renderMarkdown(text));
  }
  const controller = new AbortController(); let current = '';
  await assert.rejects(revealText('A long response here', { signal: controller.signal, delay: 1, onText: (p) => { current += p; controller.abort(); } }), { name: 'AbortError' });
  assert.ok(current.length < 'A long response here'.length);
});

test('chat reveals markdown progressively, cancels safely when switching and keeps history', async () => {
  const { initChat } = await import('../../src/js/chat.js');
  const dom = setup();
  globalThis.CSS = { escape: (s) => s };
  dom.window.HTMLElement.prototype.scrollTo = function ({ top }) { this.scrollTop = top; };
  const storage = createStorage(dom.window.localStorage); const store = createStore(storage);
  const chat = initChat({ store, getModelId: () => 'free' });
  const response = '**Bold**\n\n- item\n\n```js\nconst x = 1;\n```';
  chat.setTransport(async function* () { yield response; });
  document.getElementById('composer-input').value = 'first';
  const pending = chat.send();
  await tick();
  const first = chat.activeId;
  const partial = document.querySelector('.msg-body').textContent;
  assert.ok(partial.length > 0 && partial.length < response.length);
  chat.newChat(); await pending;
  assert.equal(chat.activeId, null);
  assert.ok(store.get(first).messages[1].content.length < response.length);
  document.getElementById('composer-input').value = 'second';
  await chat.send();
  const second = chat.activeId;
  assert.equal(store.get(second).messages[1].content, response);
  assert.ok(document.querySelector('.msg-body strong'));
  assert.ok(document.querySelector('.msg-body pre code'));
  chat.open(first); assert.equal(document.querySelector('.msg-user').textContent.trim(), 'first');
  chat.open(second); assert.equal(store.get(second).messages[0].content, 'second');
  dom.window.close();
});

test('appearance screen: the theme picker applies, annotates and persists all three themes', () => {
  const dom = setup();
  const storage = createStorage(dom.window.localStorage);
  const store = createStore(storage);
  const prefs = createPrefs(storage);
  initSettings({ prefs, store, storage });

  // Default state: Pure Black, clearly displayed.
  assert.equal(document.querySelector('[data-pref="theme"] [aria-checked="true"]').dataset.value, 'black');
  assert.match(document.getElementById('theme-note').textContent, /Pure Black/);

  for (const theme of ['light', 'night', 'black']) {
    document.querySelector(`[data-pref="theme"] [data-value="${theme}"]`).click();
    assert.equal(prefs.get('theme'), theme);
    assert.equal(document.documentElement.dataset.theme, theme, `${theme} applies instantly`);
    assert.equal(document.querySelector(`[data-pref="theme"] [data-value="${theme}"]`).getAttribute('aria-checked'), 'true');
    assert.match(document.getElementById('theme-note').textContent, new RegExp(THEME_LABELS[theme]), 'the picker names the active theme');
    assert.equal(document.querySelector('meta[name="theme-color"]').content, THEME_COLOR[theme], `${theme} drives browser chrome`);
    assert.equal(createPrefs(storage).get('theme'), theme, `${theme} is saved on this device`);
  }

  // Accent and text-size radios keep working next to the new picker.
  document.querySelector('[data-pref="accent"] [data-value="blue"]').click();
  assert.equal(document.documentElement.dataset.accent, 'blue');
  document.querySelector('[data-pref="textSize"] [data-value="lg"]').click();
  assert.equal(document.documentElement.dataset.text, 'lg');
  dom.window.close();
});
