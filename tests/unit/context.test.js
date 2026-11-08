/**
 * Regression tests for conversation context (follow-up messages).
 *
 * The reported bug: after "Who is Cid Kagenou?" the answer to "I am atomic." was
 * "Hello atomic! What can I do for you?" because the follow-up reached the model without the
 * earlier turn. These tests pin down what is sent for every edge case in the request.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import {
  buildConversationHistory, isSendableHistory, toChatMessage, HISTORY_LIMITS,
} from '../../src/js/history.js';
import { initChat } from '../../src/js/chat.js';
import { createStore } from '../../src/js/store.js';
import { createStorage } from '../../src/js/storage.js';
import { createTransport } from '../../src/js/transport.js';

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

const freshStorage = () => createStorage(new FakeLocalStorage());
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (promise) => { await promise; await tick(); };

/** A chat screen wired to a fake backend that records every request payload. */
function setupChat({ storage = freshStorage(), dom = setupDom() } = {}) {
  const store = createStore(storage);
  const sent = [];
  const chat = initChat({ store, storage, getModelId: () => 'free' });
  chat.setTransport(async function* transport(request) {
    sent.push(request);
    yield `reply-${sent.length}`;
  });
  const send = async (text) => {
    document.getElementById('composer-input').value = text;
    await settle(chat.send());
  };
  return { dom, store, chat, sent, storage, send };
}

const turn = (role, content) => ({ role, content });
const contents = (messages) => messages.map((m) => [m.role, m.content]);

// --- the history builder ---------------------------------------------------

test('context: earlier turns plus the latest message are sent in order', () => {
  const history = buildConversationHistory([
    { id: '1', role: 'user', content: 'Who is Cid Kagenou?' },
    { id: '2', role: 'assistant', content: 'The protagonist of The Eminence in Shadow.' },
    { id: '3', role: 'user', content: 'I am atomic.' },
  ]);
  assert.deepEqual(contents(history), [
    ['user', 'Who is Cid Kagenou?'],
    ['assistant', 'The protagonist of The Eminence in Shadow.'],
    ['user', 'I am atomic.'],
  ]);
  assert.equal(isSendableHistory(history), true);
});

test('context: notices, blank turns and the reply placeholder are never sent', () => {
  const history = buildConversationHistory([
    { id: '1', role: 'user', content: 'Look at this file' },
    { id: '2', role: 'assistant', content: 'I cannot open attachments yet.' },
    { id: '3', role: 'user', content: '', attachments: [{ name: 'a.pdf' }] },
    { id: '4', role: 'system', kind: 'error', content: 'The reply couldn’t be completed.' },
    { id: '5', role: 'assistant', content: '' },
    { id: '6', role: 'user', content: 'I am atomic.' },
  ], { excludeId: '5' });
  assert.deepEqual(contents(history), [
    ['user', 'Look at this file'],
    ['assistant', 'I cannot open attachments yet.'],
    ['user', 'I am atomic.'],
  ]);
  assert.equal(toChatMessage({ role: 'system', content: 'internal' }), null);
  assert.equal(toChatMessage({ role: 'user', content: '   ' }), null);
  assert.equal(toChatMessage({ role: 'tool', content: 'x' }), null);
});

test('context: history starts with a user turn and is bounded in count and size', () => {
  const messages = [];
  for (let i = 0; i < 40; i++) {
    messages.push({ id: `u${i}`, role: 'user', content: `question ${i} ${'x'.repeat(200)}` });
    messages.push({ id: `a${i}`, role: 'assistant', content: `answer ${i} ${'y'.repeat(200)}` });
  }
  messages.push({ id: 'last', role: 'user', content: 'the follow-up' });

  const history = buildConversationHistory(messages);
  assert.ok(history.length <= HISTORY_LIMITS.maxMessages, `sent ${history.length} messages`);
  assert.equal(history[0].role, 'user');
  assert.deepEqual(history.at(-1), turn('user', 'the follow-up'));
  assert.equal(history.at(-1).content, 'the follow-up');
  const total = history.reduce((sum, m) => sum + m.content.length, 0);
  assert.ok(total <= HISTORY_LIMITS.maxTotalChars, `sent ${total} characters`);
  assert.ok(JSON.stringify(history).length < 64 * 1024, 'request stays inside the Worker body limit');
});

test('context: an orphaned assistant turn is dropped and duplicates collapse', () => {
  const history = buildConversationHistory([
    { id: 'a', role: 'assistant', content: 'an answer whose question was trimmed' },
    { id: 'u', role: 'user', content: 'what did that mean?' },
  ]);
  assert.deepEqual(contents(history), [['user', 'what did that mean?']]);

  assert.deepEqual(
    contents(buildConversationHistory([
      { id: '1', role: 'user', content: 'Who is Cid Kagenou?' },
      { id: '2', role: 'assistant', content: 'Cid is the protagonist.' },
      { id: '3', role: 'user', content: 'I am atomic.' },
      { id: '4', role: 'user', content: 'I am atomic.' },
    ])),
    [['user', 'Who is Cid Kagenou?'], ['assistant', 'Cid is the protagonist.'], ['user', 'I am atomic.']],
  );

  assert.deepEqual(buildConversationHistory([]), []);
  assert.deepEqual(buildConversationHistory(null), []);
  assert.equal(isSendableHistory([]), false);
});

test('context: a single over-long turn is truncated to the per-message limit', () => {
  const history = buildConversationHistory([{ id: '1', role: 'user', content: 'z'.repeat(9000) }]);
  assert.equal(history.length, 1);
  assert.equal(history[0].content.length, HISTORY_LIMITS.maxMessageChars);
});

// --- what the chat screen actually sends -----------------------------------

test('chat: a follow-up is sent with the previous question and answer', async () => {
  const { dom, chat, sent, send } = setupChat();
  await send('Who is Cid Kagenou?');
  assert.deepEqual(contents(sent[0].messages), [['user', 'Who is Cid Kagenou?']]);

  await send('I am atomic.');
  assert.deepEqual(contents(sent[1].messages), [
    ['user', 'Who is Cid Kagenou?'],
    ['assistant', 'reply-1'],
    ['user', 'I am atomic.'],
  ]);
  assert.equal(sent[1].conversationId, sent[0].conversationId);
  assert.equal(sent[1].model, 'free');
  assert.ok(chat.activeId);
  dom.window.close();
});

test('chat: pronoun follow-ups keep the whole thread, bounded', async () => {
  const { dom, sent, send } = setupChat();
  await send('Who is Cid Kagenou?');
  await send('What did he mean by that?');
  await send('And what is his sister called?');

  assert.deepEqual(contents(sent[2].messages), [
    ['user', 'Who is Cid Kagenou?'],
    ['assistant', 'reply-1'],
    ['user', 'What did he mean by that?'],
    ['assistant', 'reply-2'],
    ['user', 'And what is his sister called?'],
  ]);
  dom.window.close();
});

test('chat: a new chat starts with no previous conversation context', async () => {
  const { dom, chat, sent, send } = setupChat();
  await send('Who is Cid Kagenou?');
  await send('I am atomic.');
  const firstId = sent[0].conversationId;

  chat.newChat();
  assert.equal(chat.activeId, null);
  await send('I am atomic.');

  assert.deepEqual(contents(sent[2].messages), [['user', 'I am atomic.']]);
  assert.notEqual(sent[2].conversationId, firstId);
  dom.window.close();
});

test('chat: switching conversations never mixes their histories', async () => {
  const { dom, store, chat, sent, send } = setupChat();
  await send('Talk about Cid Kagenou');
  await send('I am atomic.');
  const firstId = sent[0].conversationId;

  chat.newChat();
  await send('Plan a trip to Lisbon');
  const secondId = sent[2].conversationId;
  assert.notEqual(secondId, firstId);

  // Reopen the older conversation: its own history, nothing from the other chat.
  chat.open(firstId);
  await send('What did he say again?');
  const payload = sent[3].messages;
  assert.deepEqual(contents(payload), [
    ['user', 'Talk about Cid Kagenou'],
    ['assistant', 'reply-1'],
    ['user', 'I am atomic.'],
    ['assistant', 'reply-2'],
    ['user', 'What did he say again?'],
  ]);
  assert.ok(!payload.some((m) => m.content.includes('Lisbon')));

  // And back to the newer conversation: still only its own turns.
  chat.open(secondId);
  await send('Make it three days');
  assert.ok(!sent[4].messages.some((m) => m.content.includes('Cid')));
  assert.deepEqual(contents(sent[4].messages).slice(-1), [['user', 'Make it three days']]);
  assert.equal(store.get(secondId).messages.length, 4);
  dom.window.close();
});

test('chat: an older conversation still works after many turns elsewhere', async () => {
  const { dom, chat, sent, send } = setupChat();
  await send('Remember the number 42');
  const older = chat.activeId;
  chat.newChat();
  for (let i = 0; i < 4; i++) await send(`unrelated message ${i}`);
  chat.open(older);
  await send('What number did I say?');
  assert.deepEqual(contents(sent.at(-1).messages), [
    ['user', 'Remember the number 42'],
    ['assistant', 'reply-1'],
    ['user', 'What number did I say?'],
  ]);
  dom.window.close();
});

test('chat: long conversations send a bounded window that keeps the newest turn', async () => {
  const { dom, sent, send } = setupChat();
  for (let i = 0; i < 12; i++) await send(`message ${i}`);
  const payload = sent.at(-1).messages;
  assert.ok(payload.length <= HISTORY_LIMITS.maxMessages, `sent ${payload.length}`);
  assert.equal(payload[0].role, 'user');
  assert.deepEqual(payload.at(-1), turn('user', 'message 11'));
  assert.equal(payload.filter((m) => m.content === 'message 11').length, 1);
  dom.window.close();
});

test('chat: local notices and blank messages never reach the backend', async () => {
  const { dom, store, chat, sent, send } = setupChat();
  await send('Who is Cid Kagenou?');
  const convId = chat.activeId;

  store.addMessage(convId, { role: 'user', content: '', attachments: [{ name: 'notes.pdf', size: 10, type: 'application/pdf' }] });
  store.addMessage(convId, { role: 'system', kind: 'error', content: 'The reply couldn’t be completed.' });
  store.addMessage(convId, { role: 'assistant', content: '' });

  await send('I am atomic.');
  const payload = sent.at(-1).messages;
  assert.deepEqual(contents(payload), [
    ['user', 'Who is Cid Kagenou?'],
    ['assistant', 'reply-1'],
    ['user', 'I am atomic.'],
  ]);
  assert.ok(payload.every((m) => m.role === 'user' || m.role === 'assistant'));
  assert.ok(payload.every((m) => m.content.trim().length > 0));
  dom.window.close();
});

test('chat: an attachment-only message is explained instead of sent empty', async () => {
  const { dom, store, chat, sent } = setupChat();
  const input = document.getElementById('file-input');
  const file = new dom.window.File(['hello'], 'notes.txt', { type: 'text/plain' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new dom.window.Event('change'));
  assert.equal(store.count(), 0);

  await settle(chat.send());
  assert.equal(sent.length, 0, 'nothing is sent without text');
  const conv = store.get(chat.activeId);
  assert.deepEqual(conv.messages.map((m) => [m.role, m.kind ?? null]), [
    ['user', null],
    ['system', 'attachment-only'],
  ]);
  dom.window.close();
});

test('chat: the open conversation is restored after a reload, so follow-ups keep context', async () => {
  const storage = freshStorage();
  const first = setupChat({ storage });
  await first.send('Who is Cid Kagenou?');
  await first.send('I am atomic.');
  const convId = first.sent[0].conversationId;
  first.dom.window.close();

  // "Reload": a new document and a new chat screen sharing the same device storage.
  const second = setupChat({ storage });
  assert.equal(second.chat.activeId, convId);
  assert.equal(document.querySelector('.msg-user .msg-text')?.textContent, 'Who is Cid Kagenou?');

  await second.send('What did he mean?');
  assert.deepEqual(contents(second.sent[0].messages), [
    ['user', 'Who is Cid Kagenou?'],
    ['assistant', 'reply-1'],
    ['user', 'I am atomic.'],
    ['assistant', 'reply-2'],
    ['user', 'What did he mean?'],
  ]);

  // "New chat" clears the remembered conversation, so the next reload starts empty.
  second.chat.newChat();
  second.dom.window.close();
  const third = setupChat({ storage });
  assert.equal(third.chat.activeId, null);
  assert.equal(storage.get('activeConversation', null), null);
  third.dom.window.close();
});

test('chat: a remembered conversation that was deleted is ignored', async () => {
  const storage = freshStorage();
  const store = createStore(storage);
  const gone = store.create('free');
  storage.set('activeConversation', gone.id);
  store.remove(gone.id);
  const dom = setupDom();
  const chat = initChat({ store, storage, getModelId: () => 'free' });
  assert.equal(chat.activeId, null);
  assert.equal(storage.get('activeConversation', null), null);
  dom.window.close();
});

// --- transport --------------------------------------------------------------

test('transport: sends bounded, cleaned history in the existing request shape', async () => {
  const requests = [];
  const deps = {
    getToken: async () => 'token',
    fetchRequest: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ reply: 'Hello' }), { status: 200 });
    },
  };
  const messages = [
    { role: 'user', content: 'Who is Cid Kagenou?' },
    { role: 'system', kind: 'error', content: 'notice' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: 'Cid is the protagonist.' },
    { role: 'user', content: 'I am atomic.' },
  ];

  const chunks = [];
  for await (const chunk of createTransport({ conversationId: 'conv-1', model: 'free', messages }, deps)) chunks.push(chunk);

  assert.deepEqual(chunks, ['Hello']);
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    conversationId: 'conv-1',
    model: 'free',
    messages: [
      { role: 'user', content: 'Who is Cid Kagenou?' },
      { role: 'assistant', content: 'Cid is the protagonist.' },
      { role: 'user', content: 'I am atomic.' },
    ],
  });
  assert.equal(requests[0].init.headers.Authorization, 'Bearer token');
});

test('transport: refuses a request with nothing to send, without using the network', async () => {
  let tokens = 0;
  let requests = 0;
  const deps = {
    getToken: async () => { tokens++; return 'token'; },
    fetchRequest: async () => { requests++; return new Response('{}'); },
  };
  await assert.rejects(async () => {
    for await (const _ of createTransport({
      conversationId: 'c', model: 'free',
      messages: [{ role: 'system', content: 'notice' }, { role: 'user', content: '  ' }],
    }, deps)) { /* nothing */ }
  }, /no message to send/i);
  assert.equal(tokens, 0);
  assert.equal(requests, 0);
});
