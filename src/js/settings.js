/** Preferences (appearance, memory preview toggles, display name) and the settings screens' behaviour. */
import { APP } from './config.js';
import { renderMarkdown } from './markdown.js';
import { $, radioGroup, confirmDialog, toast } from './ui.js';

export const DEFAULT_PREFS = Object.freeze({
  theme: 'black', accent: 'violet', textSize: 'md', reduceMotion: false, displayName: '',
  memory: Object.freeze({ enabled: true, useHistory: true, autoSave: false }),
});
const ENUMS = { theme: ['black', 'night'], accent: ['violet', 'blue'], textSize: ['sm', 'md', 'lg'] };
const THEME_COLOR = { black: '#000000', night: '#05050d' };

export function normalizePrefs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_PREFS, memory: { ...DEFAULT_PREFS.memory } };
  for (const [key, allowed] of Object.entries(ENUMS)) if (allowed.includes(r[key])) out[key] = r[key];
  if (typeof r.reduceMotion === 'boolean') out.reduceMotion = r.reduceMotion;
  if (typeof r.displayName === 'string') out.displayName = r.displayName.trim().slice(0, 32);
  for (const key of Object.keys(DEFAULT_PREFS.memory)) {
    if (typeof r.memory?.[key] === 'boolean') out.memory[key] = r.memory[key];
  }
  return out;
}

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
}

export function createPrefs(storage) {
  let state = normalizePrefs(storage.get('prefs'));
  const subs = new Set();
  const notify = () => subs.forEach((fn) => fn(state));
  return {
    all: () => structuredClone(state),
    get: (path) => getPath(state, path),
    set(path, value) {
      const next = structuredClone(state);
      setPath(next, path, value);
      state = normalizePrefs(next);
      storage.set('prefs', state);
      notify();
    },
    reset() { state = normalizePrefs(null); storage.remove('prefs'); notify(); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

export function applyPrefs(p, root = document.documentElement) {
  root.dataset.theme = p.theme;
  root.dataset.accent = p.accent;
  root.dataset.text = p.textSize;
  root.dataset.motion = p.reduceMotion ? 'reduce' : 'full';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[p.theme] ?? '#000000');
}

const PREVIEW = [
  '**Markdown** renders in messages: *italic*, `inline code`, [links](https://example.com) and lists.',
  '',
  '- Code blocks are highlighted',
  '- Long lines scroll inside the block',
  '',
  '```js',
  '// Sample code block',
  'const tier = "PRO";',
  'console.log(`Selected ${tier}`);',
  '```',
].join('\n');

export function initSettings({ prefs, store, storage }) {
  $('settings-version').textContent = `NYX AI ${APP.version} · ${APP.stage}`;
  $('about-version').textContent = APP.version;
  $('about-stage').textContent = APP.stage;
  $('about-repo').href = APP.repo;
  $('md-preview').innerHTML = renderMarkdown(PREVIEW);

  const groups = [...document.querySelectorAll('[data-pref]')].map((el) => ({
    el, ctl: radioGroup(el, (v) => prefs.set(el.dataset.pref, v)),
  }));
  const switches = [...document.querySelectorAll('[data-switch]')];
  switches.forEach((sw) => sw.addEventListener('click', () => prefs.set(sw.dataset.switch, !prefs.get(sw.dataset.switch))));
  document.querySelectorAll('.field-row').forEach((row) => {
    const sw = row.querySelector('[data-switch]');
    if (sw) row.addEventListener('click', (e) => { if (!e.target.closest('[data-switch]')) sw.click(); });
  });

  const nameInput = $('display-name');
  nameInput.addEventListener('change', () => { prefs.set('displayName', nameInput.value); nameInput.value = prefs.get('displayName'); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); } });

  function sync() {
    const p = prefs.all();
    applyPrefs(p);
    groups.forEach(({ el, ctl }) => ctl.set(p[el.dataset.pref]));
    switches.forEach((sw) => sw.setAttribute('aria-checked', String(Boolean(prefs.get(sw.dataset.switch)))));
    const name = p.displayName || 'Guest';
    const initial = (Array.from(name)[0] || 'G').toUpperCase();
    ['profile-name', 'acct-name'].forEach((id) => { $(id).textContent = name; });
    ['profile-avatar', 'acct-avatar'].forEach((id) => { $(id).textContent = initial; });
    if (document.activeElement !== nameInput) nameInput.value = p.displayName;
  }
  const syncCount = () => { $('local-count').textContent = String(store.count()); };

  prefs.subscribe(sync);
  store.subscribe(syncCount);
  sync();
  syncCount();

  $('reset-data').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete all local data?',
      message: 'This removes every conversation and setting stored on this device. It can’t be undone.',
      confirmLabel: 'Delete everything',
    });
    if (!ok) return;
    storage.clear();
    toast('Local data deleted');
    location.hash = '#/chat';
    setTimeout(() => location.reload(), 350);
  });
}
