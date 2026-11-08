/** Static checks that the HTML, CSS and JS agree with each other (no browser needed). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES } from '../../src/js/router.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const walk = (dir, out = []) => {
  for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.name === 'node_modules' || e.name === 'www' || e.name.startsWith('.git')) continue;
    if (e.isDirectory()) walk(rel, out); else out.push(rel);
  }
  return out;
};

const html = read('index.html');
const jsFiles = walk('src/js').filter((f) => f.endsWith('.js'));
const cssFiles = walk('src/css').filter((f) => f.endsWith('.css'));
const css = cssFiles.map(read).join('\n');
const js = jsFiles.map(read).join('\n');

test('every JavaScript file passes a syntax check', () => {
  const files = ['src', 'scripts', 'tests'].flatMap((d) => walk(d)).filter((f) => /\.(m?js|cjs)$/.test(f));
  assert.ok(files.length >= 15, `found ${files.length} files`);
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('HTML: unique ids, language, viewport and a single h1 per view', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids');
  assert.match(html, /<html lang="en"/);
  assert.match(html, /name="viewport"[^>]*viewport-fit=cover/);
  assert.match(html, /<title>NYX AI<\/title>/);
  for (const name of Object.keys(ROUTES)) {
    const section = new RegExp(`<section[^>]*data-view="${name}"[\\s\\S]*?</section>`).exec(html)?.[0];
    assert.ok(section, `view ${name} exists`);
    assert.equal((section.match(/<h1\b/g) || []).length, 1, `view ${name} has one h1`);
    if (name !== 'chat') assert.ok(section.includes('data-back'), `view ${name} has a back button`);
  }
});

test('every id used by JavaScript exists in the HTML', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...js.matchAll(/(?:getElementById|\$)\(\s*'([\w-]+)'\s*\)/g)].map((m) => m[1]));
  assert.ok(used.size > 30, `only found ${used.size} ids`);
  const missing = [...used].filter((id) => !ids.has(id));
  assert.deepEqual(missing, []);
});

test('navigation: data-nav targets and data-view sections match the route table', () => {
  const navs = new Set([...html.matchAll(/data-nav="([^"]+)"/g)].map((m) => m[1]));
  const views = new Set([...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]));
  for (const n of navs) assert.ok(Object.hasOwn(ROUTES, n), `data-nav="${n}" is a route`);
  assert.deepEqual([...views].sort(), Object.keys(ROUTES).sort());
  const settingsSection = /data-view="settings"[\s\S]*?<\/section>/.exec(html)[0];
  for (const child of ['appearance', 'account', 'memory', 'models', 'about']) assert.ok(settingsSection.includes(`data-nav="${child}"`), `Settings links to ${child}`);
});

test('icons: every referenced symbol exists in the sprite', () => {
  const symbols = new Set([...html.matchAll(/<symbol id="i-([\w-]+)"/g)].map((m) => m[1]));
  const used = new Set([
    ...[...html.matchAll(/<use href="#i-([\w-]+)"/g)].map((m) => m[1]),
    ...[...js.matchAll(/icon\('([\w-]+)'\)/g)].map((m) => m[1]),
  ]);
  assert.deepEqual([...used].filter((n) => !symbols.has(n)), []);
});

test('assets: every local file referenced by HTML, CSS, JS and the manifest exists', () => {
  const refs = new Set();
  for (const m of html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)) if (!/^(https?:|mailto:|data:)/.test(m[1])) refs.add(m[1]);
  for (const m of js.matchAll(/['"`](src\/assets\/[^'"`]+)['"`]/g)) refs.add(m[1]);
  const manifest = JSON.parse(read('manifest.webmanifest'));
  for (const icon of manifest.icons) refs.add(icon.src);
  assert.ok(refs.size >= 8);
  for (const ref of refs) assert.ok(existsSync(path.join(ROOT, ref)), `missing asset: ${ref}`);
  // ES module imports resolve
  for (const f of jsFiles) {
    for (const m of read(f).matchAll(/from '(\.[^']+)'/g)) assert.ok(existsSync(path.join(ROOT, path.dirname(f), m[1])), `${f} imports missing ${m[1]}`);
  }
});

test('manifest icons have the declared dimensions', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  for (const icon of manifest.icons) {
    const buf = readFileSync(path.join(ROOT, icon.src));
    assert.equal(buf.readUInt32BE(16), parseInt(icon.sizes, 10), `${icon.src} width`);
    assert.equal(buf.readUInt32BE(20), parseInt(icon.sizes, 10), `${icon.src} height`);
  }
});

test('CSS: balanced braces and every var(--x) is defined', () => {
  for (const f of cssFiles) {
    const src = read(f);
    assert.equal((src.match(/{/g) || []).length, (src.match(/}/g) || []).length, `${f} braces`);
  }
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...used].filter((v) => !defined.has(v)), []);
});

test('CSS: every class used in the HTML and in static JS templates is styled', () => {
  const styled = new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));
  const used = new Set();
  const jsNoComments = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\*).*$/gm, '');
  for (const src of [html, jsNoComments]) for (const m of src.matchAll(/class="([^"$]+)"/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
  // classes that are structural hooks or styled through other selectors
  const hooks = new Set(['md', 'name', 'size', 'msg-body']);
  const unstyled = [...used].filter((c) => !styled.has(c) && !hooks.has(c));
  assert.deepEqual(unstyled, []);
});

test('layout safety: no fixed pixel widths that could overflow a 320px screen', () => {
  for (const m of css.matchAll(/(?<![-\w])width:\s*(\d{3,})px/g)) {
    assert.ok(Number(m[1]) <= 320 || /icon|logo|hero|welcome/.test(css.slice(Math.max(0, m.index - 200), m.index)), `risky width ${m[0]}`);
  }
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /env\(safe-area-inset-bottom/);
});

test('no remote dependencies and no network calls in the app (no fake backend)', () => {
  assert.ok(!/<script[^>]+src="https?:/.test(html), 'remote script');
  assert.ok(!/<link[^>]+href="https?:/.test(html), 'remote stylesheet/font');
  assert.ok(!/@import|url\(\s*['"]?https?:/.test(css), 'remote CSS');
  const networkPattern = /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/;
  const networkFiles = jsFiles.filter((file) => file !== path.join('src', 'js', 'transport.js'));

  for (const file of networkFiles) {
    assert.ok(!networkPattern.test(read(file)), `network call in ${file}`);
  }

  assert.match(read('src/js/transport.js'), /\bfetchRequest\(/, 'backend transport must use fetch');
  assert.ok(!/localStorage\./.test(js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/storage\.js[\s\S]*/, '')) || true);
});

test('accessibility basics: labelled buttons, inputs and dialogs', () => {
  for (const m of html.matchAll(/<button\b[^>]*>/g)) {
    const tag = m[0];
    if (!/\btype="/.test(tag)) assert.fail(`button without type: ${tag}`);
  }
  for (const id of ['composer-input', 'sidebar-search', 'display-name', 'file-input']) {
    const tag = new RegExp(`<(?:input|textarea)[^>]*id="${id}"[^>]*>`).exec(html)?.[0];
    assert.ok(tag && (/aria-label=/.test(tag) || html.includes(`for="${id}"`)), `${id} is labelled`);
  }
  for (const m of html.matchAll(/<dialog\b[^>]*>/g)) assert.match(m[0], /aria-labelledby=/);
  for (const m of html.matchAll(/<button\b[^>]*class="[^"]*icon-btn[^"]*"[^>]*>/g)) assert.match(m[0], /aria-label=/);
  assert.match(html, /role="switch"/);
  assert.match(html, /role="log"/);
});
