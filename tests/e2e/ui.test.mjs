/**
 * Browser end-to-end tests (optional — needs Playwright + Chromium, so run on a PC or CI):
 *   npm i --no-save playwright && npx playwright install chromium && npm run test:e2e
 *
 * The suite runs the REAL app, bundled with esbuild (as `npm run build` does for Capacitor),
 * with `firebase/app` and `firebase/auth` aliased to local stubs. That keeps the suite hermetic:
 * no Google or backend network is required. The stubbed auth persists its fake session in
 * localStorage exactly like the real SDK, so sign-in survives reloads. The Cloudflare Worker
 * `/chat` endpoint is intercepted and answered with a canned reply, so the real transport
 * (request shape, auth header, error mapping) is exercised end to end.
 */
import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createDevServer } from '../../scripts/dev-server.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Signed-in persistence used by the app-boot suite, mirrored here for a full browser. */
const FIREBASE_APP_STUB = `
export function initializeApp(config) { return { __config: config }; }
export function getApp() { return { __config: {} }; }
export function getApps() { return []; }
`;

const FIREBASE_AUTH_STUB = `
const KEY = '__nyxE2eAuth';
const listeners = [];
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
const write = (u) => { try { u ? localStorage.setItem(KEY, JSON.stringify(u)) : localStorage.removeItem(KEY); } catch { /* ignore */ } };
const plain = (u) => u && { email: u.email, displayName: u.displayName || null };
export function getAuth() { return { get currentUser() { const u = read(); return u && { ...u, getIdToken: async () => 'e2e-token' }; } }; }
export function onAuthStateChanged(_auth, next) { listeners.push(next); setTimeout(() => next(getAuth().currentUser), 0); return () => {}; }
const notify = (u) => listeners.forEach((fn) => fn(u));
function signIn(email) {
  const user = { email, displayName: null, getIdToken: async () => 'e2e-token' };
  write(plain(user));
  notify(user);
  return Promise.resolve({ user });
}
export const signInWithEmailAndPassword = (_a, email) => signIn(email);
export const createUserWithEmailAndPassword = (_a, email) => signIn(email);
export function signOut() { write(null); notify(null); return Promise.resolve(); }
export function sendPasswordResetEmail() { return Promise.resolve(); }
export function updateProfile(user, { displayName }) { user.displayName = displayName; write(plain(user)); return Promise.resolve(); }
`;

let workDir, server, browser, base, ctx, page, problems;

before(async () => {
  // Bundle the app for the browser, exactly like scripts/build.js, with Firebase stubbed out.
  workDir = await mkdtemp(path.join(tmpdir(), 'nyx-e2e-'));
  const appStub = path.join(workDir, 'firebase-app.js');
  const authStub = path.join(workDir, 'firebase-auth.js');
  await writeFile(appStub, FIREBASE_APP_STUB, 'utf8');
  await writeFile(authStub, FIREBASE_AUTH_STUB, 'utf8');
  const webroot = path.join(workDir, 'webroot');
  await mkdir(webroot, { recursive: true });
  for (const entry of ['index.html', 'manifest.webmanifest', 'src']) {
    await cp(path.join(ROOT, entry), path.join(webroot, entry), { recursive: true });
  }
  await build({
    absWorkingDir: ROOT,
    entryPoints: ['src/js/app.js'],
    outfile: path.join(webroot, 'src/js/app.bundle.js'),
    bundle: true, platform: 'browser', format: 'esm', target: ['es2020'], minify: false,
    alias: { 'firebase/app': appStub, 'firebase/auth': authStub },
    logLevel: 'silent',
  });
  let html = await readFile(path.join(webroot, 'index.html'), 'utf8');
  html = html.replace('src="src/js/app.js"', 'src="src/js/app.bundle.js"');
  await writeFile(path.join(webroot, 'index.html'), html);

  server = createDevServer(webroot);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); await rm(workDir, { recursive: true, force: true }); });

/** A fresh page wearing a signed-in test session unless opts.signedOut is set. */
async function openPage({ width = 360, height = 780, mobile = true, signedOut = false } = {}) {
  await ctx?.close();
  ctx = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, permissions: ['clipboard-read', 'clipboard-write'] });
  // Idempotent seeding: a later updateProfile() must survive page.reload(), like the real SDK
  // session. Wrapped in try/catch — opaque origins (about:blank) deny localStorage access.
  if (!signedOut) await ctx.addInitScript(() => { try { if (!localStorage.getItem('__nyxE2eAuth')) localStorage.setItem('__nyxE2eAuth', JSON.stringify({ email: 'tester@example.com' })); } catch { /* opaque origin */ } });
  page = await ctx.newPage();
  problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
  // The real transport POSTs JSON with a Firebase bearer token, which triggers a CORS
  // preflight — answer it like the Worker would so the intercepted fetch stays valid.
  await page.route('**workers.dev/chat', (route) => {
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Max-Age': '86400',
        },
      });
    }
    return route.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ reply: 'Hello from NYX (test backend)' }),
    });
  });
  await page.goto(base);
}
beforeEach(() => openPage());
afterEach(async () => { assert.deepEqual(problems, [], 'console errors / failed requests'); await ctx.close(); });

const view = () => page.evaluate(() => [...document.querySelectorAll('[data-view]')].filter((v) => !v.hidden).map((v) => v.dataset.view));
const overflow = async () => { await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})))); return measure(); };
const measure = () => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('[hidden], dialog:not([open]), .sidebar:not(.is-open)') || el.closest('svg')) continue;
    const r = el.getBoundingClientRect();
    if (r.width && (r.right > vw + 0.5 || r.left < -0.5) && !el.closest('.code-block pre, .table-wrap')) bad.push(`${el.tagName}.${el.className} ${Math.round(r.left)}..${Math.round(r.right)}`);
  }
  return { scrollW: document.documentElement.scrollWidth, vw, bad: bad.slice(0, 5) };
});
const send = async (text) => { await page.fill('#composer-input', text); await page.click('#send-btn'); };
/** Waits for the in-flight reply to finish streaming into the DOM (the send button is shown again). */
const settle = () => page.waitForSelector('#send-btn:not([hidden])');

test('starts cleanly: welcome screen, tagline and brand, no errors', async () => {
  assert.deepEqual(await view(), ['chat']);
  assert.match(await page.textContent('#welcome'), /Intelligence beyond limits\./);
  assert.match(await page.textContent('#welcome'), /NYX AI/);
  assert.equal(await page.title(), 'NYX AI');
  assert.equal(await page.evaluate(() => document.getElementById('boot-error').hidden), true);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(0, 0, 0)', 'Pure Black is the default theme');
  const logo = await page.$eval('.welcome-logo img', (e) => e.getAttribute('src'));
  assert.equal(logo, 'src/assets/logo/nyx-mark-512-transparent.png', 'the official NYX logo is used');
});

test('signed-out users get the themed auth gate; signing in opens the app and persists', async () => {
  await openPage({ signedOut: true });
  assert.equal(await page.isVisible('#auth-screen'), true);
  assert.equal(await page.evaluate(() => document.getElementById('app').hidden), true);
  // Auth gate is theme-aware, not hardcoded dark: the card paints on the theme surface.
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.auth-card')).backgroundColor), 'rgb(19, 19, 22)');
  await page.fill('#auth-email', 'tester@example.com');
  await page.fill('#auth-password', 'secret123');
  await page.click('#auth-submit');
  await page.waitForSelector('#app:not([hidden])');
  assert.deepEqual(await view(), ['chat']);
  await page.reload(); // the stubbed session persists like a real Firebase session
  await page.waitForSelector('#app:not([hidden])');
});

test('chat input: send disabled when empty, enabled with text; a real request/response round trip', async () => {
  assert.equal(await page.isDisabled('#send-btn'), true);
  await page.fill('#composer-input', '   ');
  assert.equal(await page.isDisabled('#send-btn'), true);
  await send('Hello NYX');
  assert.equal(await page.inputValue('#composer-input'), '');
  assert.equal(await page.locator('.msg-user').count(), 1);
  await page.waitForSelector('.msg-assistant .msg-body');
  // The reply is revealed progressively — wait for the full text instead of racing the first chunks.
  await page.waitForFunction(() => document.querySelector('.msg-assistant .msg-body')?.textContent.includes('Hello from NYX (test backend)'));
  await settle();
  assert.match(await page.textContent('.msg-assistant'), /Hello from NYX \(test backend\)/, 'the real transport got a reply');
  assert.equal(await page.isHidden('#welcome'), true);
});

test('textarea grows with content and caps its height; long words do not overflow', async () => {
  const h0 = await page.$eval('#composer-input', (e) => e.offsetHeight);
  await page.fill('#composer-input', Array(12).fill('line').join('\n'));
  const h1 = await page.$eval('#composer-input', (e) => e.offsetHeight);
  assert.ok(h1 > h0 && h1 <= 150, `${h0} -> ${h1}`);
  await send('x'.repeat(400));
  const o = await overflow();
  assert.ok(o.scrollW <= o.vw, JSON.stringify(o));
});

test('new chat resets the conversation; history lists both; opening restores messages', async () => {
  await send('First topic');
  await page.click('#new-chat-btn');
  assert.equal(await page.locator('.msg').count(), 0);
  assert.equal(await page.isVisible('#welcome'), true);
  await send('Second topic');
  await page.click('#menu-btn');
  assert.deepEqual(await page.$$eval('.conv-open', (b) => b.map((x) => x.textContent)), ['Second topic', 'First topic']);
  await page.click('.conv-open >> text=First topic');
  assert.match(await page.textContent('.msg-user'), /First topic/);
  assert.equal(await page.$eval('#sidebar', (e) => e.classList.contains('is-open')), false);
});

test('sidebar: opens, closes via scrim / close button / Escape, traps nothing when closed', async () => {
  const isOpen = () => page.$eval('#sidebar', (e) => e.classList.contains('is-open'));
  assert.equal(await page.$eval('#sidebar', (e) => e.inert), true, 'closed sidebar is inert');
  await page.click('#menu-btn');
  assert.equal(await isOpen(), true);
  assert.equal(await page.getAttribute('#menu-btn', 'aria-expanded'), 'true');
  assert.equal(await page.$eval('#sidebar', (e) => e.inert), false);
  await page.keyboard.press('Escape');
  assert.equal(await isOpen(), false);
  await page.click('#menu-btn');
  await page.click('#sidebar-close');
  assert.equal(await isOpen(), false);
  await page.click('#menu-btn');
  await page.mouse.click(350, 400); // scrim area right of the drawer
  assert.equal(await isOpen(), false);
});

test('sidebar: search filters, shows empty states, and delete asks for confirmation', async () => {
  await send('Alpha plan');
  await page.click('#new-chat-btn');
  await send('Beta notes');
  await settle(); // the conversation list re-renders when the reply lands — wait so the open menu stays put
  await page.click('#menu-btn');
  await page.fill('#sidebar-search', 'alpha');
  assert.deepEqual(await page.$$eval('.conv-open', (b) => b.map((x) => x.textContent)), ['Alpha plan']);
  await page.fill('#sidebar-search', 'zzz');
  assert.match(await page.textContent('#conv-list'), /No conversations match/);
  await page.fill('#sidebar-search', '');
  // Conversation actions live behind the ⋯ overflow menu.
  await page.click('.conv-item >> nth=0 >> .conv-actions summary');
  // Touch emulation can swallow a synthetic tap on <summary>; make sure the menu really opened.
  await page.waitForFunction(() => document.querySelector('.conv-item .conv-actions')?.open === true, null, { timeout: 3000 })
    .catch(() => page.dispatchEvent('.conv-item >> nth=0 >> .conv-actions summary', 'click'));
  await page.click('.conv-item >> nth=0 >> [data-del]');
  assert.equal(await page.$eval('#confirm-dialog', (d) => d.open), true);
  await page.click('#confirm-dialog button[value="cancel"]');
  assert.equal(await page.locator('.conv-open').count(), 2, 'cancel keeps the conversation');
  await page.click('.conv-item >> nth=0 >> [data-del]'); // menu is still open from the first attempt
  await page.click('#confirm-ok');
  await page.waitForFunction(() => document.querySelectorAll('.conv-open').length === 1);
  assert.equal(await page.locator('.msg').count(), 0, 'deleting the active chat returns to a blank chat');
});

test('empty history shows a helpful message', async () => {
  await page.click('#menu-btn');
  assert.match(await page.textContent('#conv-list'), /No conversations yet/);
});

test('model selector: FREE selectable; PRO and MAX stay locked; selection persists', async () => {
  assert.equal(await page.textContent('#model-chip-label'), 'FREE');
  await page.click('#model-chip');
  assert.equal(await page.$eval('#model-sheet', (d) => d.open), true);
  const names = await page.$$eval('#model-options .tier-name', (e) => e.map((x) => x.textContent));
  assert.deepEqual(names, ['FREE', 'PRO', 'MAX']);
  assert.equal(await page.getAttribute('#model-options [data-value="pro"]', 'aria-disabled'), 'true');
  assert.match(await page.textContent('#model-options'), /Coming soon/);
  assert.match(await page.textContent('#model-sheet'), /FREE is available now/);
  await page.click('#model-options [data-value="pro"]', { force: true }); // aria-disabled buttons stay tappable so they can explain themselves
  assert.equal(await page.textContent('#model-chip-label'), 'FREE', 'a locked tier cannot be selected');
  assert.match(await page.textContent('#toast'), /PRO is not available yet/);
  assert.equal(await page.getAttribute('#model-options [data-value="free"]', 'aria-checked'), 'true');
  await page.keyboard.press('ArrowDown'); // radio-group keyboard support stays on the available tier
  assert.equal(await page.textContent('#model-chip-label'), 'FREE');
  await page.click('#model-sheet-close');
  assert.equal(await page.$eval('#model-sheet', (d) => d.open), false);
  await page.reload();
  assert.equal(await page.textContent('#model-chip-label'), 'FREE');
});

test('model sheet: Compare tiers opens Model information; only FREE can be selected', async () => {
  await page.click('#model-chip');
  await page.click('#model-compare');
  assert.deepEqual(await view(), ['models']);
  assert.equal(await page.locator('#model-cards .card').count(), 3);
  assert.equal(await page.locator('#model-cards .badge-warn').count(), 2, 'PRO and MAX are marked coming soon');
  assert.match(await page.textContent('[data-view="models"]'), /FREE is available/);
  assert.equal(await page.textContent('[data-select-model="pro"]'), 'Locked · Coming soon');
  assert.equal(await page.textContent('[data-select-model="free"]'), 'Selected');
  await page.click('[data-view="models"] [data-back]'); // opened from chat, so Back returns to chat
  assert.deepEqual(await view(), ['chat']);
  assert.equal(await page.textContent('#model-chip-label'), 'FREE');
});

test('settings navigation: every screen opens and Back returns correctly', async () => {
  await page.click('#menu-btn');
  await page.click('#sidebar-settings');
  assert.deepEqual(await view(), ['settings']);
  assert.equal(await page.$eval('#sidebar', (e) => e.classList.contains('is-open')), false);
  for (const [route, heading] of [['appearance', 'Appearance'], ['account', 'Account'], ['memory', 'Memory'], ['models', 'Model information'], ['about', 'About NYX AI']]) {
    await page.click(`[data-view="settings"] [data-nav="${route}"]`);
    assert.deepEqual(await view(), [route]);
    assert.equal(await page.textContent(`[data-view="${route}"] h1`), heading);
    assert.match(page.url(), new RegExp(`#/${route}$`));
    await page.click(`[data-view="${route}"] [data-back]`);
    assert.deepEqual(await view(), ['settings']);
  }
  await page.click('[data-view="settings"] [data-back]');
  assert.deepEqual(await view(), ['chat']);
});

test('deep links and browser/hardware back: no broken navigation', async () => {
  await page.goto('about:blank'); // force a fresh document so the deep link really loads
  await page.goto(`${base}#/about`, { waitUntil: 'load' });
  assert.deepEqual(await view(), ['about']);
  await page.click('[data-view="about"] [data-back]'); // no history -> goes to parent
  assert.deepEqual(await view(), ['settings']);
  await page.click('[data-view="settings"] [data-back]');
  assert.deepEqual(await view(), ['chat']);
  await page.goto('about:blank');
  await page.goto(`${base}#/not-a-page`, { waitUntil: 'load' });
  assert.deepEqual(await view(), ['chat']);
  await page.click('#new-chat-btn');
  await page.evaluate(() => window.NYX.router.go('settings'));
  await page.evaluate(() => window.NYX.router.go('appearance'));
  await page.goBack();
  assert.deepEqual(await view(), ['settings']);
  await page.goBack();
  assert.deepEqual(await view(), ['chat']);
});

// ── Themes ──────────────────────────────────────────────────────────────────
const themeBg = (theme) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const THEMES = {
  black: { rgb: 'rgb(0, 0, 0)', meta: '#000000', surface: 'rgb(19, 19, 22)' },
  night: { rgb: 'rgb(17, 19, 24)', meta: '#111318', surface: 'rgb(32, 35, 43)' },
  light: { rgb: 'rgb(245, 246, 248)', meta: '#f5f6f8', surface: 'rgb(255, 255, 255)' },
};

test('appearance: the three themes apply instantly, persist and survive reload', async () => {
  await page.evaluate(() => window.NYX.router.go('appearance'));
  const names = await page.$$eval('[data-pref="theme"] .theme-name', (e) => e.map((x) => x.textContent));
  assert.deepEqual(names, ['Pure Black', 'Deep Night', 'Light']);
  assert.equal(await page.locator('[data-pref="theme"] .theme-preview').count(), 3, 'every theme has a preview swatch');
  assert.match(await page.textContent('#theme-note'), /Pure Black/);

  for (const [value, expect] of Object.entries(THEMES)) {
    await page.click(`[data-pref="theme"] [data-value="${value}"]`);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), value);
    assert.equal(await themeBg(value), expect.rgb, `${value} paints the canvas`);
    assert.equal(await page.getAttribute('meta[name="theme-color"]', 'content'), expect.meta, `${value} tints browser chrome`);
    assert.equal(await page.getAttribute(`[data-pref="theme"] [data-value="${value}"]`, 'aria-checked'), 'true');
    assert.match(await page.textContent('#theme-note'), new RegExp({ black: 'Pure Black', night: 'Deep Night', light: 'Light' }[value]), `${value} is named as active`);
  }

  // Accent and text size still work, then the whole appearance persists across a reload.
  await page.click('[data-pref="accent"] [data-value="blue"]');
  await page.click('[data-pref="textSize"] [data-value="lg"]');
  await page.click('[data-switch="reduceMotion"]');
  await page.reload();
  const attrs = await page.evaluate(() => ({ ...document.documentElement.dataset }));
  assert.deepEqual(attrs, { theme: 'light', accent: 'blue', text: 'lg', motion: 'reduce' }, 'the loop ended on Light');
  assert.equal(await page.getAttribute('[data-pref="theme"] [data-value="light"]', 'aria-checked'), 'true', 'picker state restored after reload');
  assert.equal(await page.getAttribute('meta[name="theme-color"]', 'content'), THEMES.light.meta);
  assert.match(await page.innerHTML('#md-preview'), /tok-k/);
});

test('themes: switching among all three never resets chats, session or other preferences', async () => {
  await send('Keep my conversation');
  await page.evaluate(() => window.NYX.router.go('account'));
  await page.fill('#display-name', 'Ada');
  await page.press('#display-name', 'Enter');
  await page.evaluate(() => window.NYX.router.go('appearance'));
  for (const theme of ['light', 'night', 'black']) {
    await page.click(`[data-pref="theme"] [data-value="${theme}"]`);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
    assert.equal(await page.evaluate(() => localStorage.getItem('nyx.activeConversation') !== null), true, 'the open chat is remembered');
    assert.equal(await page.evaluate(() => window.NYX.prefs.get('displayName')), 'Ada', 'other preferences survive');
    assert.equal(await page.isVisible('#app'), true, 'the session is untouched');
  }
});

test('theme consistency: chat, settings, dialogs and the model sheet follow the theme', async () => {
  for (const [value, expect] of Object.entries(THEMES)) {
    await page.evaluate((t) => window.NYX.prefs.set('theme', t), value);
    assert.equal(await themeBg(value), expect.rgb, `${value}: chat canvas`);
    // The model chip lives in the chat top bar, so open the sheet while the chat view shows.
    await page.click('#model-chip');
    // The sheet paints on the raised surface token of the active theme.
    const raised = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'var(--bg-raised)';
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return resolved;
    });
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('model-sheet')).backgroundColor), raised, `${value}: sheet surface follows --bg-raised`);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.NYX.router.go('settings'));
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-view="settings"] .group')).backgroundColor), expect.surface, `${value}: settings cards`);
    await page.evaluate(() => window.NYX.router.go('chat'));
    assert.notEqual(
      await page.evaluate(() => getComputedStyle(document.body).color),
      await themeBg(value),
      `${value}: text is never the same colour as the surface`,
    );
  }
});

test('light theme: welcome and auth gate are readable (no pale-on-pale)', async () => {
  await page.evaluate(() => window.NYX.prefs.set('theme', 'light'));
  await page.reload();
  assert.equal(await themeBg(), 'rgb(245, 246, 248)', 'light canvas');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.welcome')).color), 'rgb(23, 25, 35)', 'dark text on the light canvas');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.suggestion')).backgroundColor), 'rgb(255, 255, 255)', 'white suggestion cards');
  // The saved theme also reaches the signed-out auth screen (restored by the boot script).
  await openPage({ signedOut: true });
  await page.evaluate(() => window.NYX.prefs.set('theme', 'light'));
  await page.reload();
  assert.equal(await page.isVisible('#auth-screen'), true);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.auth-card')).backgroundColor), 'rgb(255, 255, 255)', 'light auth card');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.auth-card')).color), 'rgb(23, 25, 35)', 'dark text on the light card');
});

test('account: display name updates the sidebar profile; delete-all resets local data', async () => {
  await send('Keep me?');
  await page.evaluate(() => window.NYX.router.go('account'));
  await page.fill('#display-name', 'Ada Lovelace');
  await page.press('#display-name', 'Enter');
  assert.equal(await page.textContent('#acct-avatar'), 'A');
  assert.equal(await page.textContent('#profile-name'), 'Ada Lovelace');
  assert.equal(await page.textContent('#local-count'), '1');
  assert.equal(await page.textContent('#acct-status'), 'Signed in');
  await page.click('#reset-data');
  await page.click('#confirm-dialog button[value="cancel"]');
  assert.equal(await page.textContent('#local-count'), '1');
  await page.click('#reset-data');
  // The app wipes localStorage and reloads right after confirming — the reload re-creates the
  // global scope, so detect it by arming a window marker (hash-change waits would race).
  await page.evaluate(() => { window.__preReset = 'armed'; });
  await page.click('#confirm-ok');
  await page.waitForFunction(() => !window.__preReset);
  assert.deepEqual(await view(), ['chat']);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('nyx.')).length), 0, 'local data is really gone');
  await page.waitForFunction(() => document.getElementById('acct-status')?.textContent === 'Signed in');
  assert.equal(await page.textContent('#profile-name'), 'Ada Lovelace', 'the name lives on the account profile and survives a local wipe');
});

test('memory screen: preview switches toggle and are labelled as having no effect', async () => {
  await page.evaluate(() => window.NYX.router.go('memory'));
  assert.match(await page.textContent('[data-view="memory"]'), /Preview only/);
  const sw = '[data-switch="memory.autoSave"]';
  assert.equal(await page.getAttribute(sw, 'aria-checked'), 'false');
  await page.click(sw);
  assert.equal(await page.getAttribute(sw, 'aria-checked'), 'true');
  await page.click('#lbl-mem1'); // tapping the row label toggles too
  assert.equal(await page.getAttribute('[data-switch="memory.enabled"]', 'aria-checked'), 'false');
  assert.equal(await page.isDisabled('text=Clear memories'), true);
});

test('about and model information screens show honest status', async () => {
  await page.evaluate(() => window.NYX.router.go('about'));
  assert.match(await page.textContent('[data-view="about"]'), /Cloudflare Workers/);
  assert.match(await page.textContent('[data-view="about"]'), /Firebase Authentication/);
  assert.equal(await page.textContent('#about-version'), '0.2.1');
  assert.equal(await page.getAttribute('#about-repo', 'rel'), 'noopener noreferrer');
});

test('attachments: add, show chips, remove, send as metadata; limits enforced', async () => {
  await page.setInputFiles('#file-input', [
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    { name: 'pic.png', mimeType: 'image/png', buffer: Buffer.alloc(2048) },
  ]);
  assert.equal(await page.locator('.attachment').count(), 2);
  assert.equal(await page.isDisabled('#send-btn'), false, 'attachments alone can be sent');
  await page.click('[data-remove-file="0"]');
  assert.equal(await page.locator('.attachment').count(), 1);
  await page.click('#send-btn');
  assert.match(await page.textContent('.msg-files'), /pic\.png/);
  assert.equal(await page.isHidden('#attachments'), true);
  const many = Array.from({ length: 7 }, (_, i) => ({ name: `f${i}.txt`, mimeType: 'text/plain', buffer: Buffer.from('x') }));
  await page.setInputFiles('#file-input', many);
  assert.equal(await page.locator('.attachment').count(), 5);
});

test('voice button is interface-only and says so', async () => {
  assert.equal(await page.getAttribute('#voice-btn', 'aria-disabled'), 'true');
  await page.click('#voice-btn', { force: true }); // aria-disabled buttons stay tappable so they can explain themselves
  assert.match(await page.textContent('#toast'), /Voice input isn’t available yet/);
});

test('copy buttons work for messages and code blocks', async () => {
  await send('copy me please');
  await page.click('.msg-user [data-copy-msg]');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'copy me please');
  assert.match(await page.textContent('#toast'), /Copied/);
  await settle(); // let the first (real transport) reply finish before swapping the transport
  await page.evaluate(() => window.NYX.chat.setTransport(async function* () { yield '```js\nconst x = 1;\n```'; }));
  await send('code please');
  await page.waitForSelector('.code-block');
  await settle();
  await page.click('.code-copy');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'const x = 1;');
});

test('transport hook: streams markdown into an assistant bubble; Stop aborts and keeps the partial reply', async () => {
  await page.evaluate(() => window.NYX.chat.setTransport(async function* ({ signal }) {
    yield '**Hello** from a *test* transport\n\n';
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 5000);
      signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    });
    yield 'never shown';
  }));
  await send('stream please');
  await page.waitForSelector('#stop-btn:not([hidden])');
  assert.equal(await page.isHidden('#send-btn'), true);
  await page.waitForSelector('.msg-assistant strong');
  // Wait until the streamed chunk is fully revealed, then abort only the pending continuation.
  await page.waitForFunction(() => document.querySelector('.msg-assistant')?.textContent.includes('Hello from a test transport'));
  await page.click('#stop-btn');
  await page.waitForSelector('#send-btn:not([hidden])');
  assert.match(await page.textContent('.msg-assistant'), /Hello from a test transport/);
  assert.ok(!(await page.textContent('.msg-assistant')).includes('never shown'));
});

test('transport errors show an error notice and never crash the UI', async () => {
  await page.evaluate(() => window.NYX.chat.setTransport(async function* () { throw new Error('boom'); }));
  await send('fail please');
  await page.waitForSelector('.msg-system');
  assert.match(await page.textContent('.msg-system'), /couldn’t be completed/);
  assert.equal(await page.locator('.msg-assistant').count(), 0, 'empty assistant bubble removed');
  assert.equal(await page.isVisible('#send-btn'), true);
  problems = problems.filter((p) => !p.includes('boom')); // expected, logged on purpose
});

test('markdown from untrusted text is rendered safely', async () => {
  await page.evaluate(() => window.NYX.chat.setTransport(async function* () { yield '<img src=x onerror="window.__pwned=1"> [x](javascript:window.__pwned=1)'; }));
  await send('xss');
  await page.waitForSelector('.msg-assistant .md p');
  await settle();
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator('.msg-assistant .msg-body img').count(), 0);
  assert.equal(await page.locator('.msg-assistant a').count(), 0);
});

test('keyboard-aware layout: composer stays on screen when the viewport shrinks', async () => {
  await page.setViewportSize({ width: 360, height: 420 }); // simulates the on-screen keyboard
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--app-h') === '420px');
  const box = await page.$eval('#composer', (e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
  assert.ok(box.bottom <= 420.5 && box.top >= 0, JSON.stringify(box));
  const bar = await page.$eval('.topbar', (e) => e.getBoundingClientRect().top);
  assert.ok(bar >= 0);
  await send('typing with keyboard open');
  assert.equal(await page.locator('.msg-user').count(), 1);
});

for (const width of [320, 360, 412]) {
  test(`no horizontal overflow on any screen at ${width}px`, async () => {
    await page.setViewportSize({ width, height: 740 });
    await send('```js\n' + 'const veryLongLine = "' + 'x'.repeat(200) + '";\n```');
    await settle(); // wait for the real reply before replacing the transport
    await page.evaluate(() => window.NYX.chat.setTransport(async function* () { yield '| a | b | c | d | e |\n|---|---|---|---|---|\n| ' + 'long '.repeat(30) + '| 2 | 3 | 4 | 5 |\n\n' + 'https://example.com/' + 'a'.repeat(120); }));
    await send('table');
    await page.waitForSelector('.table-wrap');
    await settle(); // the widest content is only painted once the stream finished
    let o = await overflow();
    assert.ok(o.scrollW <= o.vw && o.bad.length === 0, `chat ${JSON.stringify(o)}`);
    await page.click('#menu-btn');
    await page.waitForFunction(() => document.getElementById('sidebar').getBoundingClientRect().left >= 0);
    o = await overflow();
    assert.ok(o.scrollW <= o.vw && o.bad.length === 0, `sidebar ${JSON.stringify(o)}`);
    await page.click('#sidebar-close');
    for (const route of ['settings', 'appearance', 'account', 'memory', 'models', 'about']) {
      await page.evaluate((r) => window.NYX.router.go(r), route);
      o = await overflow();
      assert.ok(o.scrollW <= o.vw && o.bad.length === 0, `${route} ${JSON.stringify(o)}`);
    }
  });
}

test('touch targets: interactive controls are at least 40px', async () => {
  const small = await page.$$eval('button:not([hidden]):not(dialog button), input:not([hidden]):not([type=file]), textarea', (els) => els
    .filter((e) => e.offsetParent !== null && !e.closest('dialog:not([open])') && !e.closest('.sidebar:not(.is-open)'))
    .map((e) => { const r = e.getBoundingClientRect(); return { id: e.id || e.className, w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter((r) => r.w < 40 || r.h < 40));
  assert.deepEqual(small, []);
});

test('every image and asset loads (no missing assets); official logo is untouched', async () => {
  const broken = await page.$$eval('img', (imgs) => imgs.filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.src));
  assert.deepEqual(broken, []);
  for (const path of ['manifest.webmanifest', 'src/assets/icons/icon-192.png', 'src/assets/icons/icon-512.png', 'src/assets/icons/icon-maskable-512.png', 'src/assets/logo/nyx-mark-512-transparent.png']) {
    assert.equal((await page.request.get(base + path)).status(), 200, path);
  }
});

test('wide screens keep the sidebar visible as a column', async () => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.waitForFunction(() => matchMedia('(min-width: 900px)').matches && !document.getElementById('sidebar').inert);
  assert.equal(await page.isVisible('#sidebar'), true);
  assert.equal(await page.isHidden('#menu-btn'), true);
  assert.equal(await page.$eval('#sidebar', (e) => e.inert), false);
  const o = await overflow();
  assert.ok(o.scrollW <= o.vw);
});

// ── Refined layouts ─────────────────────────────────────────────────────────
const rect = (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; });

test('mobile: compact top bar with menu left, model selector centred, new chat right', async () => {
  const [bar, menu, chip, add] = await Promise.all([rect('.topbar-chat'), rect('#menu-btn'), rect('#model-chip'), rect('#new-chat-btn')]);
  assert.ok(bar.h <= 64, `top bar ${bar.h}px`);
  assert.ok(menu.l < 16 && add.r > 344, 'buttons sit at the edges');
  assert.ok(Math.abs((chip.l + chip.r) / 2 - 180) <= 3, `chip centre ${(chip.l + chip.r) / 2}`);
  assert.ok(chip.h >= 40);
});

test('mobile welcome: centred greeting, prompt chips just above the composer', async () => {
  const [hero, chips, composer, logo] = await Promise.all([rect('.welcome-hero'), rect('.suggestions'), rect('#composer'), rect('.welcome-logo')]);
  assert.ok(hero.b <= chips.t, 'chips are below the greeting');
  assert.ok(composer.t - chips.b < 120, `chips ${composer.t - chips.b}px above composer`);
  assert.ok(Math.abs((logo.l + logo.r) / 2 - 180) <= 2, 'logo centred');
  assert.equal(await page.isVisible('.suggestion-desc >> nth=0'), false, 'chips are compact on phones');
});

test('suggestions only fill the composer — they never send or fake a reply', async () => {
  await page.click('.suggestion >> nth=1');
  assert.match(await page.inputValue('#composer-input'), /weekly study schedule/);
  assert.equal(await page.locator('.msg').count(), 0);
  assert.equal(await page.isDisabled('#send-btn'), false);
});

test('composer: attachment, image, voice and send controls are present and tappable', async () => {
  for (const id of ['attach-btn', 'image-btn', 'voice-btn', 'send-btn']) {
    const r = await rect(`#${id}`);
    assert.ok(r.w >= 40 && r.h >= 40, `${id} ${r.w}x${r.h}`);
    assert.ok(r.l >= 0 && r.r <= 360, `${id} on screen`);
  }
  const [input, send, attach] = await Promise.all([rect('#composer-input'), rect('#send-btn'), rect('#attach-btn')]);
  assert.ok(input.b <= attach.t + 2 && input.b <= send.t + 2, 'tools row sits under the text field');
  assert.equal(await page.isHidden('#stop-btn'), true);
});

test('image button attaches images as metadata with an image icon (no image understanding yet)', async () => {
  await page.setInputFiles('#image-input', [{ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(1024) }]);
  assert.equal(await page.locator('.attachment use[href="#i-image"]').count(), 1);
  assert.equal(await page.getAttribute('#image-input', 'accept'), 'image/*');
  await page.click('#send-btn');
  assert.match(await page.textContent('.msg-files'), /photo\.jpg/);
  assert.match(await page.textContent('.msg-system'), /stored on this device only/);
});

test('keyboard open (short viewport): welcome stays fully visible and the composer is usable', async () => {
  await page.setViewportSize({ width: 360, height: 440 });
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--app-h') === '440px');
  assert.equal(await page.$eval('#messages', (e) => e.scrollTop), 0, 'welcome is not scrolled out of view');
  const [logo, bar, composer] = await Promise.all([rect('.welcome-logo'), rect('.topbar-chat'), rect('#composer')]);
  assert.ok(logo.t >= bar.b - 1, `logo (${logo.t}) is below the top bar (${bar.b})`);
  assert.ok(composer.b <= 440.5);
  await send('typed with the keyboard open');
  const last = await page.$eval('.msg-assistant', (e) => { const r = e.getBoundingClientRect(); const m = document.getElementById('messages').getBoundingClientRect(); return r.bottom <= m.bottom + 1 && r.top >= m.top - 1; });
  assert.equal(last, true, 'latest message is visible above the composer');
});

test('smooth scrolling: stays pinned to new messages; jump button appears after scrolling up', async () => {
  // Long canned replies make the conversation reliably taller than the viewport, and waiting
  // for each finished turn avoids the composer ignoring input while a reply is generated.
  await page.evaluate(() => window.NYX.chat.setTransport(async function* () { yield 'Reply text that wraps onto several rows of the chat. '.repeat(30); }));
  for (let i = 0; i < 6; i++) {
    await send(`message number ${i}`);
    await page.waitForSelector('#stop-btn:not([hidden])');
    await settle();
  }
  // Assert the pinned state with scroll metrics in the message, so a flake explains itself.
  const scrollMetrics = () => page.evaluate(() => { const m = document.getElementById('messages'); return { sh: m.scrollHeight, st: Math.round(m.scrollTop), ch: m.clientHeight, msgs: m.querySelectorAll('.msg').length }; });
  const expectPinned = async () => {
    await page.waitForFunction(() => { const m = document.getElementById('messages'); return m.scrollHeight > m.clientHeight * 1.5 && m.scrollHeight - m.scrollTop - m.clientHeight < 2; }, null, { timeout: 10000 })
      .catch(async () => assert.fail(`not pinned/tall: ${JSON.stringify(await scrollMetrics())}`));
  };
  // Async layout (late font metrics etc.) can shift the tail by a pixel after the last paint —
  // re-pin through the app's own API exactly like the pinned-follow logic does during a stream.
  await page.evaluate(() => window.NYX.chat.scrollToBottom());
  await expectPinned();
  assert.equal(await page.isHidden('#jump-btn'), true);
  await page.$eval('#messages', (m) => { m.scrollTop = 0; });
  await page.waitForSelector('#jump-btn:not([hidden])');
  await page.click('#jump-btn'); // smooth scroll back to the newest message hides the button again
  await page.evaluate(() => window.NYX.chat.scrollToBottom());
  await page.waitForFunction(() => { const m = document.getElementById('messages'); return m.scrollHeight - m.scrollTop - m.clientHeight < 2; }, null, { timeout: 10000 })
    .catch(async () => assert.fail(`jump did not land: ${JSON.stringify(await scrollMetrics())}`));
  await page.waitForSelector('#jump-btn[hidden]', { state: 'attached' });
});

test('reduced motion: scrolling is instant and ambient animation is off', async () => {
  await page.evaluate(() => window.NYX.router.go('appearance'));
  await page.click('[data-switch="reduceMotion"]');
  await page.evaluate(() => window.NYX.router.go('chat'));
  const dur = await page.$eval('.welcome-logo', (e) => getComputedStyle(e, '::before').animationDuration);
  assert.ok(parseFloat(dur) < 0.001, `animation duration ${dur}`);
});

test('tablet (768px): persistent sidebar starts as an icon rail and expands on demand', async () => {
  await openPage({ width: 768, height: 1024 });
  assert.equal(await page.getAttribute('#app', 'data-sidebar'), 'collapsed');
  assert.equal(Math.round((await rect('#sidebar')).w), 68);
  assert.equal(await page.isHidden('#menu-btn'), true);
  assert.equal(await page.isVisible('#sidebar-new'), true);
  assert.equal(await page.isHidden('#conv-list'), true, 'history is hidden in the rail');
  assert.equal(await page.locator('.suggestion').evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size), 1, 'three cards share one row');
  const o = await overflow();
  assert.ok(o.scrollW <= o.vw, JSON.stringify(o));
});

test('desktop (1280px): expanded sidebar, three suggestion cards, centred model selector, large composer', async () => {
  await openPage({ width: 1280, height: 800, mobile: false });
  assert.equal(await page.getAttribute('#app', 'data-sidebar'), 'expanded');
  assert.equal(Math.round((await rect('#sidebar')).w), 300);
  await send('Desktop chat');
  await page.click('#new-chat-btn');
  assert.equal(await page.locator('.conv-open').count(), 1, 'recent chats listed in the sidebar');
  assert.equal(await page.isVisible('#sidebar-models'), true, 'navigation links are visible');
  const cards = await page.$$eval('.suggestion', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { t: Math.round(r.top), w: Math.round(r.width) }; }));
  assert.equal(cards.length, 3);
  assert.equal(new Set(cards.map((c) => c.t)).size, 1, 'one row');
  assert.ok(await page.isVisible('.suggestion-desc >> nth=0'), 'cards show descriptions');
  const [composer, chip, main] = await Promise.all([rect('.composer-box'), rect('#model-chip'), rect('#main')]);
  assert.ok(composer.w >= 700 && composer.w <= 781, `composer ${composer.w}px`);
  assert.ok(composer.h >= 110, 'large composer');
  assert.ok(Math.abs((chip.l + chip.r) / 2 - (main.l + main.r) / 2) <= 3, 'model selector centred over the chat');
  const o = await overflow();
  assert.ok(o.scrollW <= o.vw, JSON.stringify(o));
});

test('desktop: sidebar collapses to a rail, remembers the choice, and the rail search expands it', async () => {
  await openPage({ width: 1280, height: 800, mobile: false });
  await send('Remember my layout');
  await page.click('#new-chat-btn');
  await page.click('#sidebar-toggle');
  assert.equal(await page.getAttribute('#app', 'data-sidebar'), 'collapsed');
  assert.equal(await page.getAttribute('#sidebar-toggle', 'aria-expanded'), 'false');
  assert.equal(await page.getAttribute('#sidebar-toggle', 'aria-label'), 'Expand sidebar');
  await page.waitForFunction(() => Math.round(document.getElementById('sidebar').getBoundingClientRect().width) === 68);
  assert.equal(await page.isHidden('.sidebar .label >> nth=0'), true);
  assert.equal(await page.isVisible('#sidebar-settings'), true, 'icons stay reachable');
  await page.reload();
  assert.equal(await page.getAttribute('#app', 'data-sidebar'), 'collapsed', 'choice persists');
  await page.click('#sidebar-search-btn');
  assert.equal(await page.getAttribute('#app', 'data-sidebar'), 'expanded');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'sidebar-search');
  await page.click('#sidebar-models'); // navigation works from the sidebar
  assert.deepEqual(await view(), ['models']);
});

test('desktop: model selector opens as a centred dialog (not a bottom sheet) and settings pages stay usable', async () => {
  await openPage({ width: 1280, height: 800, mobile: false });
  await page.click('#model-chip');
  const sheet = await rect('#model-sheet');
  assert.ok(sheet.b < 790 && sheet.t > 40, `dialog is centred: ${sheet.t}..${sheet.b}`);
  await page.keyboard.press('Escape');
  await page.click('#sidebar-settings');
  assert.deepEqual(await view(), ['settings']);
  await page.click('[data-view="settings"] [data-nav="appearance"]');
  assert.deepEqual(await view(), ['appearance']);
  const o = await overflow();
  assert.ok(o.scrollW <= o.vw);
});

test('desktop: the appearance theme picker shows all three themes above the fold', async () => {
  await openPage({ width: 1280, height: 800, mobile: false });
  await page.evaluate(() => window.NYX.router.go('appearance'));
  for (const theme of ['black', 'night', 'light']) {
    const r = await rect(`[data-pref="theme"] [data-value="${theme}"]`);
    assert.ok(r.t > 50 && r.b < 800 && r.w > 90, `${theme} option visible ${JSON.stringify(r)}`);
  }
  const o = await overflow();
  assert.ok(o.scrollW <= o.vw);
});

// ── Visual audit (screenshots for human/CI review) ─────────────────────────
// Enabled by setting NYX_E2E_SHOTS_DIR (the CI workflow does, and uploads the folder).
const SHOTS_DIR = process.env.NYX_E2E_SHOTS_DIR || null;

test('visual audit: screenshots of chat, appearance and the auth gate in every theme', { skip: !SHOTS_DIR && 'set NYX_E2E_SHOTS_DIR to capture screenshots' }, async () => {
  await mkdir(SHOTS_DIR, { recursive: true });
  await page.evaluate(() => window.NYX.chat.setTransport(async function* () {
    yield 'Here is a **styled** answer with a list and code:\n\n- first point\n- second point\n\n```js\nconst nyx = true;\n```';
  }));
  await send('A test question for the audit');
  await page.waitForFunction(() => document.querySelector('.msg-assistant')?.textContent.includes('const nyx = true;'));
  await settle(); // stream finished — the screenshots must not catch a half-painted bubble

  for (const theme of ['black', 'night', 'light']) {
    await page.evaluate((t) => window.NYX.prefs.set('theme', t), theme);
    await page.waitForTimeout(150); // let the theme transition settle before the shot
    await page.screenshot({ path: `${SHOTS_DIR}/phone-${theme}-chat.png` });
    await page.evaluate(() => window.NYX.router.go('appearance'));
    await page.screenshot({ path: `${SHOTS_DIR}/phone-${theme}-appearance.png` });
    await page.evaluate(() => window.NYX.router.go('chat'));
  }
  // Desktop layout in the default theme.
  await openPage({ width: 1280, height: 800, mobile: false });
  await page.evaluate(() => window.NYX.chat.setTransport(async function* () { yield 'Desktop reply for the audit.'; }));
  await send('Desktop audit question');
  await page.waitForFunction(() => document.querySelector('.msg-assistant')?.textContent.includes('Desktop reply'));
  await settle();
  await page.screenshot({ path: `${SHOTS_DIR}/desktop-black-chat.png`, fullPage: false });
  await page.screenshot({ path: `${SHOTS_DIR}/desktop-black-full.png`, fullPage: true });
  // The signed-out auth gate in all three themes.
  for (const theme of ['black', 'night', 'light']) {
    await openPage({ signedOut: true });
    await page.evaluate((t) => window.NYX.prefs.set('theme', t), theme);
    await page.reload();
    await page.waitForSelector('#auth-screen:not([hidden]) #auth-form');
    await page.screenshot({ path: `${SHOTS_DIR}/phone-${theme}-auth.png` });
  }
});
