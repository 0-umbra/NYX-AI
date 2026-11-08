/**
 * Application boot and session-flow regression tests.
 *
 * The reported symptom was the generic "Something went wrong. Please try again." toast. That
 * string is produced in exactly one place — `bindGlobalErrors()` in `src/js/app.js`, which listens
 * for `window` `error` and `unhandledrejection` events — so it does not describe a feature: it
 * means an exception or a rejected promise escaped somewhere in the page.
 *
 * These tests bundle the real `src/js/app.js` (with Firebase stubbed out) and drive it in jsdom
 * through the flows that matter, asserting that no error or unhandled rejection is raised and that
 * the generic toast is never shown. If a future change makes `send()`, the auth gate or a reload
 * throw, this suite fails.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = await readFile(path.join(ROOT, 'index.html'), 'utf8');
const GENERIC_TOAST = 'Something went wrong. Please try again.';

let workDir;
let bundlePath;
let bootCounter = 0;

// One process-level listener for the whole file: a promise rejected with nothing to catch it is a
// Node `unhandledRejection`, not a jsdom window event, and that is exactly what the global error
// handler in app.js would be reacting to in a browser.
let currentProblems = null;
process.on('unhandledRejection', (reason) => {
  if (currentProblems) currentProblems.push(`unhandledRejection: ${reason?.stack || reason}`);
});

const FIREBASE_APP_STUB = `
export function initializeApp(config) { return { __config: config }; }
export function getApp() { return { __config: {} }; }
export function getApps() { return []; }
`;

const FIREBASE_AUTH_STUB = `
const listeners = [];
let user = null;
export function getAuth() { return { get currentUser() { return user; } }; }
export function onAuthStateChanged(_auth, next) { listeners.push({ next }); }
function signIn() {
  user = { email: 'tester@example.com', getIdToken: async () => 'test-id-token' };
  for (const listener of listeners) listener.next(user);
  return Promise.resolve({ user });
}
export const signInWithEmailAndPassword = signIn;
export const createUserWithEmailAndPassword = signIn;
export function signOut() {
  user = null;
  for (const listener of listeners) listener.next(null);
  return Promise.resolve();
}
export function sendPasswordResetEmail() { return Promise.resolve(); }
export function updateProfile() { return Promise.resolve(); }
`;

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'nyx-boot-'));
  const appStub = path.join(workDir, 'firebase-app.js');
  const authStub = path.join(workDir, 'firebase-auth.js');
  await writeFile(appStub, FIREBASE_APP_STUB, 'utf8');
  await writeFile(authStub, FIREBASE_AUTH_STUB, 'utf8');
  // A `.mjs` bundle: Node treats `.js` as CommonJS outside this package, and a CJS require is
  // cached by filename, which would make the second "boot" reuse the first module instance.
  bundlePath = path.join(workDir, 'app.bundle.mjs');
  await build({
    absWorkingDir: ROOT,
    entryPoints: ['src/js/app.js'],
    outfile: bundlePath,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: ['es2020'],
    minify: false,
    alias: { 'firebase/app': appStub, 'firebase/auth': authStub },
  });
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function installGlobals(window) {
  const set = (key, value) => {
    if (value === undefined) return;
    try { Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); } catch { /* ignore */ }
  };
  for (const key of ['window', 'document', 'navigator', 'location', 'history', 'localStorage',
    'sessionStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'DOMException',
    'crypto', 'structuredClone', 'TextEncoder', 'TextDecoder', 'AbortController', 'HTMLElement',
    'HTMLDialogElement', 'Event', 'CustomEvent', 'Node', 'Element']) {
    set(key, window[key]);
  }
  Object.defineProperty(globalThis, 'self', { value: window, configurable: true, writable: true });
  window.HTMLElement.prototype.scrollTo = function scrollTo({ top } = {}) { this.scrollTop = top ?? 0; };
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  window.HTMLDialogElement.prototype.close = function close(value = '') {
    this.returnValue = value;
    this.open = false;
    this.dispatchEvent(new window.Event('close'));
  };
  window.matchMedia = window.matchMedia ?? ((query) => ({
    media: query, matches: false, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  }));
  set('matchMedia', window.matchMedia);
  Object.defineProperty(globalThis, 'CSS', { value: { escape: (s) => s }, configurable: true, writable: true });
}

/** Boots the real application bundle in a fresh document, optionally seeding device storage. */
async function boot({ seed = null } = {}) {
  const dom = new JSDOM(HTML, { url: 'https://nyx.test/', pretendToBeVisual: true });
  const { window } = dom;
  installGlobals(window);

  const problems = [];
  currentProblems = problems;
  window.addEventListener('error', (event) => problems.push(`error: ${event.error?.stack || event.message}`));
  window.addEventListener('unhandledrejection', (event) => problems.push(`unhandledrejection: ${event.reason?.stack || event.reason}`));

  if (seed) {
    for (const [key, value] of Object.entries(seed)) window.localStorage.setItem(key, value);
  }

  // A unique URL per boot: Node caches ES modules by specifier, and each boot needs its own
  // module instance bound to its own document and storage.
  await import(`${pathToFileURL(bundlePath).href}?boot=${++bootCounter}`);
  await tick(60);

  const toastText = () => window.document.getElementById('toast').textContent;
  const stage = (label) => {
    const text = toastText();
    assert.notEqual(text, GENERIC_TOAST, `${label}: the generic error toast was shown`);
    assert.deepEqual(problems, [], `${label}: ${problems.join(' | ')}`);
  };

  return {
    dom, window, problems, stage, toastText,
    /** Signs in through the real authentication form. */
    async signIn() {
      window.document.getElementById('auth-email').value = 'tester@example.com';
      window.document.getElementById('auth-password').value = 'secret123';
      window.document.getElementById('auth-form')
        .dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
      await tick(60);
    },
    async signOut() {
      window.document.getElementById('account-logout').click();
      await tick(60);
    },
    setTransport(fn) { window.NYX.chat.setTransport(fn); },
    async send(text) {
      window.document.getElementById('composer-input').value = text;
      window.document.getElementById('composer')
        .dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
      await tick(400);
    },
    /** Device storage as it would persist across a reload. */
    storage() {
      const out = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        out[key] = window.localStorage.getItem(key);
      }
      return out;
    },
  };
}

test('boot: the app starts, shows the auth gate and raises no unhandled error', async () => {
  const app = await boot();
  try {
    app.stage('boot');
    assert.equal(app.window.document.getElementById('app').hidden, true, 'the app stays hidden until signed in');
    assert.equal(app.window.document.getElementById('auth-screen').hidden, false);
    assert.equal(app.window.document.getElementById('boot-error').hidden, true, 'no fatal boot error');
    assert.equal(typeof app.window.NYX, 'object');
    assert.equal(app.window.NYX.chat.activeId, null);
  } finally {
    app.dom.window.close();
  }
});

test('session: sign in, follow-up, new chat and sign out never raise an unhandled error', async () => {
  const app = await boot();
  try {
    await app.signIn();
    app.stage('after sign-in');
    assert.equal(app.window.document.getElementById('app').hidden, false, 'the app is shown');
    assert.equal(app.window.document.getElementById('auth-screen').hidden, true);

    const sent = [];
    app.setTransport(async function* transport(request) {
      sent.push(request);
      yield `reply-${sent.length}`;
    });

    await app.send('Who is Cid Kagenou?');
    app.stage('after first message');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].messages, [{ role: 'user', content: 'Who is Cid Kagenou?' }]);

    await app.send('I am atomic.');
    app.stage('after follow-up');
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].messages, [
      { role: 'user', content: 'Who is Cid Kagenou?' },
      { role: 'assistant', content: 'reply-1' },
      { role: 'user', content: 'I am atomic.' },
    ], 'the follow-up carries the previous turn');
    assert.equal(sent[1].conversationId, sent[0].conversationId);

    const activeBefore = app.window.NYX.chat.activeId;
    app.window.NYX.chat.newChat();
    app.stage('after new chat');
    assert.equal(app.window.NYX.chat.activeId, null);

    await app.send('Plan a trip to Lisbon');
    app.stage('after starting a new chat');
    assert.notEqual(sent[2].conversationId, activeBefore);
    assert.deepEqual(sent[2].messages, [{ role: 'user', content: 'Plan a trip to Lisbon' }], 'a new chat has no prior context');

    await app.signOut();
    app.stage('after sign out');
    assert.equal(app.window.document.getElementById('app').hidden, true);
    assert.equal(app.window.document.getElementById('auth-screen').hidden, false);
    assert.equal(app.window.NYX.chat.activeId, null);
  } finally {
    app.dom.window.close();
  }
});

test('reload: the open conversation is restored and follow-ups keep their context', async () => {
  const first = await boot();
  let conversationId;
  let seed;
  try {
    await first.signIn();
    const sent = [];
    first.setTransport(async function* transport(request) { sent.push(request); yield `reply-${sent.length}`; });
    await first.send('Who is Cid Kagenou?');
    await first.send('I am atomic.');
    conversationId = sent[0].conversationId;
    seed = first.storage();
    first.stage('before reload');
    assert.equal(first.window.NYX.chat.activeId, conversationId);
  } finally {
    first.dom.window.close();
  }

  // A new document sharing the same device storage = reopening the app or restarting the WebView.
  const second = await boot({ seed });
  try {
    await second.signIn();
    second.stage('after reload');
    assert.equal(second.window.NYX.chat.activeId, conversationId, 'the open conversation is restored');
    assert.equal(second.window.document.querySelectorAll('.msg-user').length, 2);

    const sent = [];
    second.setTransport(async function* transport(request) { sent.push(request); yield `reply-${sent.length}`; });
    await second.send('What did he mean by that?');
    second.stage('after reload follow-up');
    assert.equal(sent.at(-1).conversationId, conversationId, 'the follow-up stays in the same conversation');
    assert.deepEqual(sent.at(-1).messages, [
      { role: 'user', content: 'Who is Cid Kagenou?' },
      { role: 'assistant', content: 'reply-1' },
      { role: 'user', content: 'I am atomic.' },
      { role: 'assistant', content: 'reply-2' },
      { role: 'user', content: 'What did he mean by that?' },
    ], 'the restored history reaches the model');
  } finally {
    second.dom.window.close();
  }
});

test('transport failure: a rejected request is reported in the conversation, not as a global error', async () => {
  const app = await boot();
  try {
    await app.signIn();
    app.setTransport(async function* () { throw new Error('provider exploded'); });
    await app.send('please fail');
    app.stage('after a failed request');
    const notice = app.window.document.querySelector('.msg-system');
    assert.ok(notice, 'an error notice is shown in the conversation');
    assert.match(notice.textContent, /couldn’t be completed|could not be sent/);
    assert.equal(app.window.document.querySelectorAll('.msg-assistant').length, 0, 'the empty assistant bubble is removed');
  } finally {
    app.dom.window.close();
  }
});

test('send: a message cannot be lost to an unhandled rejection', async () => {
  const app = await boot();
  try {
    await app.signIn();
    // A transport that throws before yielding: runTransport handles it, and send() must not reject.
    app.setTransport(async function* () { throw new Error('immediate failure'); });
    await assert.doesNotReject(app.send('fail immediately'));
    app.stage('after an immediately failing transport');
  } finally {
    app.dom.window.close();
  }
});

test('send: a failure before the transport is reported in the conversation', async () => {
  const app = await boot();
  try {
    await app.signIn();
    const store = app.window.NYX.store;
    const original = store.addMessage;
    let calls = 0;
    store.addMessage = function addMessage(...args) {
      calls++;
      if (calls === 1) throw new Error('device storage exploded');
      return original.apply(this, args);
    };
    try {
      // Without the guard this rejects, the submit handler does not await it, and the window's
      // unhandled-rejection handler shows the generic "Something went wrong" toast instead.
      await assert.doesNotReject(app.send('this message cannot be stored'));
      app.stage('after a throwing store');
      const notice = app.window.document.querySelector('.msg-system');
      assert.ok(notice, 'an error notice is shown in the conversation');
      assert.match(notice.textContent, /could not be sent/);
    } finally {
      store.addMessage = original;
    }
  } finally {
    app.dom.window.close();
  }
});
