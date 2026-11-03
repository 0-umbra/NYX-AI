/**
 * Browser end-to-end tests (optional — needs Playwright + Chromium, so run on a PC or CI, not in Termux):
 *   npm i --no-save playwright && npx playwright install chromium && npm run test:e2e
 * Starts the real dev server and drives the app in a phone-sized Chromium.
 */
import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createDevServer } from '../../scripts/dev-server.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

let server, browser, base, ctx, page, problems;

before(async () => {
  server = createDevServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function openPage({ width = 360, height = 780, mobile = true } = {}) {
  await ctx?.close();
  ctx = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, permissions: ['clipboard-read', 'clipboard-write'] });
  page = await ctx.newPage();
  problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
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

test('starts cleanly: welcome screen, tagline and backend-not-connected notice', async () => {
  assert.deepEqual(await view(), ['chat']);
  assert.match(await page.textContent('#welcome'), /Intelligence beyond limits\./);
  assert.match(await page.textContent('#welcome'), /AI backend not connected/);
  assert.equal(await page.title(), 'NYX AI');
  assert.equal(await page.evaluate(() => document.getElementById('boot-error').hidden), true);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(0, 0, 0)');
});

test('chat input: send disabled when empty, enabled with text, message + honest notice, no fake reply', async () => {
  assert.equal(await page.isDisabled('#send-btn'), true);
  await page.fill('#composer-input', '   ');
  assert.equal(await page.isDisabled('#send-btn'), true);
  await send('Hello NYX');
  assert.equal(await page.inputValue('#composer-input'), '');
  assert.equal(await page.locator('.msg-user').count(), 1);
  assert.equal(await page.locator('.msg-assistant').count(), 0, 'no assistant reply is fabricated');
  assert.match(await page.textContent('.msg-system'), /AI backend not connected/);
  assert.equal(await page.isHidden('#welcome'), true);
  assert.equal(await page.isDisabled('#send-btn'), true);
  assert.equal(await page.isHidden('#stop-btn'), true);
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
  await page.click('#menu-btn');
  await page.fill('#sidebar-search', 'alpha');
  assert.deepEqual(await page.$$eval('.conv-open', (b) => b.map((x) => x.textContent)), ['Alpha plan']);
  await page.fill('#sidebar-search', 'zzz');
  assert.match(await page.textContent('#conv-list'), /No conversations match/);
  await page.fill('#sidebar-search', '');
  await page.click('[data-del] >> nth=0');
  assert.equal(await page.$eval('#confirm-dialog', (d) => d.open), true);
  await page.click('#confirm-dialog button[value="cancel"]');
  assert.equal(await page.locator('.conv-open').count(), 2, 'cancel keeps the conversation');
  await page.click('[data-del] >> nth=0');
  await page.click('#confirm-ok');
  await page.waitForFunction(() => document.querySelectorAll('.conv-open').length === 1);
  assert.equal(await page.locator('.msg').count(), 0, 'deleting the active chat returns to a blank chat');
});

test('empty history shows a helpful message', async () => {
  await page.click('#menu-btn');
  assert.match(await page.textContent('#conv-list'), /No conversations yet/);
});

test('model selector: FREE/PRO/MAX with descriptions, selection persists across reload', async () => {
  assert.equal(await page.textContent('#model-chip-label'), 'FREE');
  await page.click('#model-chip');
  assert.equal(await page.$eval('#model-sheet', (d) => d.open), true);
  const names = await page.$$eval('#model-options .tier-name', (e) => e.map((x) => x.textContent));
  assert.deepEqual(names, ['FREE', 'PRO', 'MAX']);
  assert.match(await page.textContent('#model-options'), /No connected|Deeper reasoning/);
  assert.match(await page.textContent('#model-sheet'), /No models are connected yet/);
  await page.click('#model-options [data-value="pro"]');
  assert.equal(await page.textContent('#model-chip-label'), 'PRO');
  assert.equal(await page.getAttribute('#model-options [data-value="pro"]', 'aria-checked'), 'true');
  assert.equal(await page.getAttribute('#model-options [data-value="free"]', 'aria-checked'), 'false');
  await page.keyboard.press('ArrowDown'); // radio-group keyboard support
  assert.equal(await page.textContent('#model-chip-label'), 'MAX');
  await page.click('#model-sheet-close');
  assert.equal(await page.$eval('#model-sheet', (d) => d.open), false);
  await page.reload();
  assert.equal(await page.textContent('#model-chip-label'), 'MAX');
});

test('model sheet: Compare tiers opens Model information; cards select a tier', async () => {
  await page.click('#model-chip');
  await page.click('#model-compare');
  assert.deepEqual(await view(), ['models']);
  assert.equal(await page.locator('#model-cards .card').count(), 3);
  assert.equal(await page.locator('#model-cards .badge-warn').count(), 3);
  await page.click('[data-select-model="max"]');
  assert.equal(await page.isDisabled('[data-select-model="max"]'), true);
  await page.click('[data-view="models"] [data-back]'); // opened from chat, so Back returns to chat
  assert.deepEqual(await view(), ['chat']);
  assert.equal(await page.textContent('#model-chip-label'), 'MAX');
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
  await page.goto(`${base}#/about`);
  assert.deepEqual(await view(), ['about']);
  await page.click('[data-view="about"] [data-back]'); // no history -> goes to parent
  assert.deepEqual(await view(), ['settings']);
  await page.click('[data-view="settings"] [data-back]');
  assert.deepEqual(await view(), ['chat']);
  await page.goto(`${base}#/not-a-page`);
  assert.deepEqual(await view(), ['chat']);
  await page.click('#new-chat-btn');
  await page.evaluate(() => window.NYX.router.go('settings'));
  await page.evaluate(() => window.NYX.router.go('appearance'));
  await page.goBack();
  assert.deepEqual(await view(), ['settings']);
  await page.goBack();
  assert.deepEqual(await view(), ['chat']);
});

test('appearance: theme, accent and text size apply instantly and persist', async () => {
  await page.goto(`${base}#/appearance`);
  await page.click('[data-pref="accent"] [data-value="blue"]');
  await page.click('[data-pref="theme"] [data-value="night"]');
  await page.click('[data-pref="textSize"] [data-value="lg"]');
  await page.click('[data-switch="reduceMotion"]');
  const attrs = () => page.evaluate(() => ({ ...document.documentElement.dataset }));
  assert.deepEqual(await attrs(), { theme: 'night', accent: 'blue', text: 'lg', motion: 'reduce' });
  assert.equal(await page.getAttribute('[data-switch="reduceMotion"]', 'aria-checked'), 'true');
  assert.equal(await page.getAttribute('meta[name="theme-color"]', 'content'), '#05050d');
  await page.reload();
  assert.deepEqual(await attrs(), { theme: 'night', accent: 'blue', text: 'lg', motion: 'reduce' });
  assert.equal(await page.getAttribute('[data-pref="accent"] [data-value="blue"]', 'aria-checked'), 'true');
  assert.match(await page.innerHTML('#md-preview'), /tok-k/);
});

test('account: display name updates the sidebar profile; delete-all resets everything', async () => {
  await send('Keep me?');
  await page.goto(`${base}#/account`);
  await page.fill('#display-name', 'Ada Lovelace');
  await page.press('#display-name', 'Enter');
  assert.equal(await page.textContent('#acct-avatar'), 'A');
  assert.equal(await page.textContent('#profile-name'), 'Ada Lovelace');
  assert.equal(await page.textContent('#local-count'), '1');
  assert.equal(await page.isDisabled('[data-view="account"] .btn-primary'), true, 'sign in is not faked');
  await page.click('#reset-data');
  await page.click('#confirm-dialog button[value="cancel"]');
  assert.equal(await page.textContent('#local-count'), '1');
  await page.click('#reset-data');
  await page.click('#confirm-ok');
  await page.waitForFunction(() => document.getElementById('profile-name').textContent === 'Guest' && !localStorage.getItem('nyx.conversations'));
  await page.waitForLoadState('load');
  assert.deepEqual(await view(), ['chat']);
});

test('memory screen: preview switches toggle and are labelled as having no effect', async () => {
  await page.goto(`${base}#/memory`);
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
  await page.goto(`${base}#/about`);
  assert.match(await page.textContent('[data-view="about"]'), /Not connected/);
  assert.match(await page.textContent('[data-view="about"]'), /Cloudflare Workers/);
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
  await page.evaluate(() => window.NYX.chat.setTransport(async function* () { yield '```js\nconst x = 1;\n```'; }));
  await send('code please');
  await page.waitForSelector('.code-block');
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
  assert.equal(await page.locator('.msg-system').count(), 0, 'no "not connected" notice when a transport exists');
  await page.click('#stop-btn');
  await page.waitForSelector('#send-btn:not([hidden])');
  assert.match(await page.textContent('.msg-assistant'), /Hello from a test transport/);
  assert.ok(!(await page.textContent('.msg-assistant')).includes('never shown'));
});

test('transport errors show an error notice and never crash the UI', async () => {
  await page.evaluate(() => window.NYX.chat.setTransport(async function* () { throw new Error('boom'); }));
  await send('fail please');
  await page.waitForSelector('.msg-system');
  assert.match(await page.textContent('.msg-system'), /Something went wrong/);
  assert.equal(await page.locator('.msg-assistant').count(), 0, 'empty assistant bubble removed');
  assert.equal(await page.isVisible('#send-btn'), true);
  problems = problems.filter((p) => !p.includes('transport error') && !p.includes('boom')); // expected, logged on purpose
});

test('markdown from untrusted text is rendered safely', async () => {
  await page.evaluate(() => window.NYX.chat.setTransport(async function* () { yield '<img src=x onerror="window.__pwned=1"> [x](javascript:window.__pwned=1)'; }));
  await send('xss');
  await page.waitForSelector('.msg-assistant .md p');
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
    await page.evaluate(() => window.NYX.chat.setTransport(async function* () { yield '| a | b | c | d | e |\n|---|---|---|---|---|\n| ' + 'long '.repeat(30) + '| 2 | 3 | 4 | 5 |\n\n' + 'https://example.com/' + 'a'.repeat(120); }));
    await send('table');
    await page.waitForSelector('.table-wrap');
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
  const small = await page.$$eval('button:not([hidden]), input:not([hidden]):not([type=file]), textarea', (els) => els
    .filter((e) => e.offsetParent !== null && !e.closest('dialog:not([open])') && !e.closest('.sidebar:not(.is-open)'))
    .map((e) => { const r = e.getBoundingClientRect(); return { id: e.id || e.className, w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter((r) => r.w < 40 || r.h < 40));
  assert.deepEqual(small, []);
});

test('every image and asset loads (no missing assets)', async () => {
  const broken = await page.$$eval('img', (imgs) => imgs.filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.src));
  assert.deepEqual(broken, []);
  for (const path of ['manifest.webmanifest', 'src/assets/icons/icon-192.png', 'src/assets/icons/icon-512.png', 'src/assets/icons/icon-maskable-512.png']) {
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

// ── Refined layouts (Stage 2.1) ─────────────────────────────────────────────
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

test('image button attaches images as metadata with an image icon; nothing is uploaded', async () => {
  await page.setInputFiles('#image-input', [{ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(1024) }]);
  assert.equal(await page.locator('.attachment use[href="#i-image"]').count(), 1);
  assert.equal(await page.getAttribute('#image-input', 'accept'), 'image/*');
  await page.click('#send-btn');
  assert.match(await page.textContent('.msg-files'), /photo\.jpg/);
  assert.match(await page.textContent('.msg-system'), /AI backend not connected/);
});

test('keyboard open (short viewport): welcome stays fully visible and the composer is usable', async () => {
  await page.setViewportSize({ width: 360, height: 440 });
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--app-h') === '440px');
  assert.equal(await page.$eval('#messages', (e) => e.scrollTop), 0, 'welcome is not scrolled out of view');
  const [logo, bar, composer] = await Promise.all([rect('.welcome-logo'), rect('.topbar-chat'), rect('#composer')]);
  assert.ok(logo.t >= bar.b - 1, `logo (${logo.t}) is below the top bar (${bar.b})`);
  assert.ok(composer.b <= 440.5);
  await send('typed with the keyboard open');
  const last = await page.$eval('.msg-system', (e) => { const r = e.getBoundingClientRect(); const m = document.getElementById('messages').getBoundingClientRect(); return r.bottom <= m.bottom + 1 && r.top >= m.top - 1; });
  assert.equal(last, true, 'latest message is visible above the composer');
});

test('smooth scrolling: stays pinned to new messages; jump button appears after scrolling up', async () => {
  for (let i = 0; i < 10; i++) await send(`message number ${i} `.repeat(6));
  await page.waitForFunction(() => { const m = document.getElementById('messages'); return m.scrollHeight - m.scrollTop - m.clientHeight < 4; });
  assert.equal(await page.isHidden('#jump-btn'), true);
  await page.$eval('#messages', (m) => { m.scrollTop = 0; });
  await page.waitForSelector('#jump-btn:not([hidden])');
  await page.click('#jump-btn');
  await page.waitForFunction(() => { const m = document.getElementById('messages'); return m.scrollHeight - m.scrollTop - m.clientHeight < 4; });
  await page.waitForSelector('#jump-btn[hidden]', { state: 'attached' });
});

test('reduced motion: scrolling is instant and ambient animation is off', async () => {
  await page.goto(`${base}#/appearance`);
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
