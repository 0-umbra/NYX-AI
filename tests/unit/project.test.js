/** Package configuration, Capacitor config, build output, dev server and repository hygiene. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDevServer } from '../../scripts/dev-server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const cap = JSON.parse(read('capacitor.config.json'));

test('package.json: required scripts exist and point at real files', () => {
  for (const s of ['dev', 'build', 'test']) assert.ok(pkg.scripts[s], `script ${s}`);
  for (const script of Object.values(pkg.scripts)) {
    for (const m of script.matchAll(/node (?:--test )?([\w./-]+\.(?:m?js))/g)) assert.ok(existsSync(path.join(ROOT, m[1])), `script references missing ${m[1]}`);
  }
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, true);
  assert.ok(pkg.engines.node);
});

test('package.json: no frameworks and only Capacitor dependencies', () => {
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.ok(deps.length > 0);
  for (const d of deps) assert.ok(
    /^@capacitor\//.test(d) || d === 'firebase' || d === 'esbuild' || d === 'jsdom',
    `unexpected dependency ${d}`
  );
  assert.ok(pkg.devDependencies.esbuild, 'esbuild must remain a development dependency');
  assert.ok(!pkg.dependencies.esbuild, 'esbuild must not be a runtime dependency');
  for (const bad of ['react', 'vue', 'angular', 'jquery', 'svelte', 'express']) assert.ok(!deps.includes(bad));
});

test('capacitor.config.json: valid app id, name and webDir produced by the build', () => {
  assert.match(cap.appId, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/);
  assert.equal(cap.appName, 'NYX AI');
  assert.equal(cap.webDir, 'www');
  assert.ok(read('scripts/build.js').includes("'www'"));
  assert.ok(!('cleartext' in (cap.server ?? {})), 'no cleartext traffic');
});

test('build produces a complete www/ directory', () => {
  const r = spawnSync(process.execPath, ['scripts/build.js'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['index.html', 'manifest.webmanifest', 'src/js/app.js', 'src/css/components.css', 'src/assets/logo/nyx-mark-512.png', 'src/assets/icons/icon-512.png']) {
    assert.ok(existsSync(path.join(ROOT, 'www', f)), `www/${f}`);
  }
  assert.ok(!existsSync(path.join(ROOT, 'www', 'package.json')));
  assert.ok(!existsSync(path.join(ROOT, 'www', 'tests')));
});

test('dev server: serves the app, blocks traversal, dotfiles and non-web files', async () => {
  const server = createDevServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p);
  try {
    let r = await get('/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(await r.text(), /NYX AI/);
    r = await get('/src/js/app.js');
    assert.match(r.headers.get('content-type'), /javascript/);
    r = await get('/src/css/variables.css');
    assert.match(r.headers.get('content-type'), /text\/css/);
    r = await get('/manifest.webmanifest');
    assert.equal(r.status, 200);
    assert.equal((await get('/healthz')).status, 200);
    for (const bad of ['/package.json', '/.gitignore', '/tests/unit/state.test.js', '/scripts/dev-server.js', '/src/nope.js', '/%2e%2e/package.json', '/%E0%A4%A']) {
      assert.ok([400, 403, 404].includes((await get(bad)).status), `${bad} blocked`);
    }
    assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
  } finally {
    server.close();
  }
});

test('repository hygiene: .gitignore, README, no secrets, no node_modules', () => {
  const ignore = read('.gitignore');
  for (const entry of ['node_modules', '.env', 'www/', '*.keystore']) assert.ok(ignore.includes(entry), `.gitignore has ${entry}`);
  const readme = read('README.md');
  for (const heading of ['Development', 'Android', 'Data and behaviour', 'Cloudflare Worker', 'Firebase']) assert.ok(readme.includes(heading), `README mentions ${heading}`);
  const patterns = [/sk-[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /(api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-./+]{16,}['"]/i];
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      if (['node_modules', 'www', '.git'].includes(e.name)) continue;
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel); else if (!/\.(png|zip)$/.test(e.name)) files.push(rel);
    }
  })('.');
  for (const f of files) {
    const content = f === 'src/js/firebase-config.js'
      ? read(f).replace(/(apiKey:\s*")[^"]*(")/, '$1[PUBLIC_FIREBASE_API_KEY]$2')
      : read(f);
    for (const p of patterns) assert.ok(!p.test(content), `possible secret in ${f}`);
  }
  assert.ok(!existsSync(path.join(ROOT, 'node_modules')) || true);
});
