/**
 * Theme system tests: the three appearances (Pure Black / Deep Night / Light), their design
 * tokens, WCAG contrast for every semantic text/control pairing, persistence and restore,
 * and the anti-flash boot script staying in sync with the settings module.
 *
 * If a token value regresses contrast (e.g. pale text on a pale surface), these tests fail
 * before the app does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { DEFAULT_PREFS, THEME_COLOR, THEME_LABELS, applyPrefs, createPrefs, normalizePrefs } from '../../src/js/settings.js';
import { createStorage } from '../../src/js/storage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const THEMES = ['black', 'night', 'light'];
const ACCENTS = ['violet', 'blue'];

/** The semantic colour/elevation tokens every appearance must resolve (components depend on them). */
const REQUIRED_TOKENS = [
  'bg', 'bg-raised', 'surface', 'surface-2', 'surface-3', 'overlay',
  'line', 'line-strong', 'text', 'text-2', 'text-3',
  'accent', 'accent-deep', 'accent-deep-2', 'accent-2', 'accent-text',
  'accent-soft', 'accent-line', 'accent-ring', 'on-accent', 'gradient',
  'bubble-user', 'bubble-user-line',
  'danger', 'danger-soft', 'danger-line', 'warn', 'warn-text', 'warn-soft', 'warn-line', 'ok',
  'shadow-1', 'shadow-2', 'shadow-3',
  'ambient-a', 'ambient-b', 'welcome-halo',
  'code-bg', 'code-head-bg', 'code-line', 'code-text', 'tok-c', 'tok-s', 'tok-k', 'tok-f', 'tok-n',
];

// ── Tiny CSS token resolver ──────────────────────────────────────────────────

/** Reads the design-token blocks from variables.css (cascade order: later rules win). */
function tokenRules() {
  const css = read('src/css/variables.css');
  const rules = [];
  for (const m of css.matchAll(/(:root(?:\[[^\]]+\])*)\s*\{([^{}]*)\}/g)) {
    const decls = {};
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls[d[1]] = d[2].trim();
    rules.push({ selector: m[1], decls });
  }
  return rules;
}

/** Effective token map for a theme × accent combination, honouring the cascade. */
function resolveTokens(theme, accent) {
  const map = {};
  for (const rule of tokenRules()) {
    const themeMatch = /\[data-theme="(\w+)"\]/.exec(rule.selector);
    const accentMatch = /\[data-accent="(\w+)"\]/.exec(rule.selector);
    if (themeMatch && themeMatch[1] !== theme) continue;
    if (accentMatch && accentMatch[1] !== accent) continue;
    Object.assign(map, rule.decls);
  }
  // Resolve var(--x) references between declarations (e.g. --accent: var(--violet)).
  const resolving = new Set();
  const value = (name) => {
    const key = name.startsWith('--') ? name : `--${name}`;
    assert.ok(!resolving.has(key), `circular var() chain at ${key}`);
    assert.ok(key in map, `${key} is not defined for theme=${theme} accent=${accent}`);
    resolving.add(key);
    let v = map[key];
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    if (ref) v = value(ref[1]);
    resolving.delete(key);
    return v;
  };
  return { value };
}

// ── Colour maths ─────────────────────────────────────────────────────────────

/** Parses '#rrggbb', 'rgb(...)' and 'rgba(...)' into { rgb, alpha }. */
function parseColor(raw) {
  const s = String(raw).trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  assert.ok(rgba, `unparseable colour token value: ${s}`);
  return { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: rgba[4] === undefined ? 1 : Number(rgba[4]) };
}
const channel = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = (rgb) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
const contrast = (fgRgb, bgRgb) => {
  const [l1, l2] = [luminance(fgRgb), luminance(bgRgb)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
};
/** A translucent token composited onto a solid background, as the GPU would blend it. */
function over(fgRaw, bgRaw) {
  const fg = parseColor(fgRaw);
  const bg = parseColor(bgRaw);
  return fg.rgb.map((c, i) => Math.round(c * fg.alpha + bg.rgb[i] * (1 - fg.alpha)));
}

// ── Token completeness and contrast ─────────────────────────────────────────

test('Deep Night palette: the approved brand values are pinned exactly', () => {
  const tokens = resolveTokens('night', 'violet');
  assert.equal(tokens.value('bg'), '#111318', 'graphite background');
  assert.equal(tokens.value('surface'), '#20232b', 'charcoal surfaces');
  assert.equal(tokens.value('violet'), '#a99ae8', 'muted violet');
  assert.equal(tokens.value('accent'), '#a99ae8', 'muted violet is the violet accent');
  assert.equal(tokens.value('blue'), '#83a6c9', 'steel blue');
  assert.equal(tokens.value('text'), '#f0f0f2', 'soft white text');
});

test('theme tokens: every theme × accent combination resolves the full semantic set', () => {
  for (const theme of THEMES) {
    for (const accent of ACCENTS) {
      const tokens = resolveTokens(theme, accent);
      for (const token of REQUIRED_TOKENS) {
        const v = tokens.value(token); // throws when missing or circular
        assert.notEqual(v, '', `--${token} is not empty for ${theme}/${accent}`);
      }
    }
  }
});

/**
 * Semantic pairings that must beat WCAG AA everywhere.
 * `overBg` entries are translucent tints, so they are checked composited onto both the
 * page background and the card surface they can appear on. `solidBg` entries are opaque.
 */
const CONTRAST_PAIRS = [
  ['primary text on background', 'text', null, 'bg', 7],
  ['secondary text on background', 'text-2', null, 'bg', 4.5],
  ['secondary text on surfaces', 'text-2', null, 'surface', 4.5],
  ['secondary text on raised surfaces', 'text-2', null, 'surface-2', 4.5],
  ['muted text on background', 'text-3', null, 'bg', 3],
  ['muted text on surfaces', 'text-3', null, 'surface', 3],
  ['accent text on background', 'accent-text', null, 'bg', 4.5],
  ['accent text on surfaces', 'accent-text', null, 'surface', 4.5],
  ['primary-button label', 'on-accent', null, 'accent-deep', 4.5],
  ['primary-button gradient end', 'on-accent', null, 'accent-deep-2', 4.5],
  ['accent text on accent tint over background', 'accent-text', 'accent-soft', 'bg', 4.5],
  ['accent text on accent tint over surfaces', 'accent-text', 'accent-soft', 'surface', 4.5],
  ['message text inside the user bubble', 'text', 'bubble-user', 'bg', 4.5],
  ['danger text on danger tint', 'danger', 'danger-soft', 'surface', 4.5],
  ['warning text on warning tint', 'warn-text', 'warn-soft', 'surface', 4.5],
];

test('theme contrast: every semantic text and control pairing beats WCAG AA in all six appearances', () => {
  for (const theme of THEMES) {
    for (const accent of ACCENTS) {
      const tokens = resolveTokens(theme, accent);
      for (const [label, fg, tint, base, min] of CONTRAST_PAIRS) {
        const fgRgb = parseColor(tokens.value(fg)).rgb;
        const bgRgb = tint ? over(tokens.value(tint), tokens.value(base)) : parseColor(tokens.value(base)).rgb;
        const ratio = contrast(fgRgb, bgRgb);
        assert.ok(
          ratio >= min,
          `[${theme}/${accent}] ${label}: ${contrast(fgRgb, bgRgb).toFixed(2)}:1 < ${min}:1 `
          + `(${tokens.value(fg)} on ${tint ? `${tint} over ${base}` : base})`,
        );
      }
    }
  }
});

test('theme contrast: syntax highlighting tokens stay legible on the code surface', () => {
  for (const theme of THEMES) {
    const tokens = resolveTokens(theme, 'violet');
    const codeBg = parseColor(tokens.value('code-bg')).rgb;
    assert.ok(contrast(parseColor(tokens.value('code-text')).rgb, codeBg) >= 7, `[${theme}] code body text`);
    for (const tok of ['tok-s', 'tok-k', 'tok-f', 'tok-n']) {
      assert.ok(contrast(parseColor(tokens.value(tok)).rgb, codeBg) >= 4.5, `[${theme}] --${tok} (${tokens.value(tok)})`);
    }
    assert.ok(contrast(parseColor(tokens.value('tok-c')).rgb, codeBg) >= 3, `[${theme}] --tok-c comments`);
  }
});

// ── Preferences: selection, persistence, restore ─────────────────────────────

class FakeLocalStorage {
  #d = new Map();
  get length() { return this.#d.size; }
  key(i) { return [...this.#d.keys()][i] ?? null; }
  getItem(k) { return this.#d.has(k) ? this.#d.get(k) : null; }
  setItem(k, v) { this.#d.set(k, String(v)); }
  removeItem(k) { this.#d.delete(k); }
}

test('theme prefs: all three themes are valid choices and invalid values fall back safely', () => {
  for (const theme of THEMES) {
    assert.equal(normalizePrefs({ theme }).theme, theme, `${theme} accepted`);
    assert.ok(THEME_COLOR[theme], `${theme} has a chrome colour`);
    assert.ok(THEME_LABELS[theme], `${theme} has a display name`);
  }
  assert.equal(normalizePrefs({ theme: 'solarized' }).theme, DEFAULT_PREFS.theme, 'unknown theme falls back');
  assert.equal(normalizePrefs({ theme: 42 }).theme, DEFAULT_PREFS.theme, 'non-string theme falls back');
  assert.equal(DEFAULT_PREFS.theme, 'black', 'the default theme stays Pure Black');
});

test('theme persistence: a chosen theme survives an app restart; reset restores the default', () => {
  const storage = createStorage(new FakeLocalStorage());
  const first = createPrefs(storage);
  first.set('theme', 'light');
  first.set('accent', 'blue');
  // Reopen the app: a fresh prefs instance over the same device storage restores the choice.
  const reopened = createPrefs(storage);
  assert.equal(reopened.get('theme'), 'light');
  assert.equal(reopened.get('accent'), 'blue');
  reopened.reset();
  assert.equal(createPrefs(storage).get('theme'), DEFAULT_PREFS.theme);
});

test('theme persistence: switching between all themes updates storage without touching other preferences', () => {
  const storage = createStorage(new FakeLocalStorage());
  const prefs = createPrefs(storage);
  prefs.set('displayName', 'Ada');
  prefs.set('textSize', 'lg');
  for (const theme of [...THEMES, 'black']) {
    prefs.set('theme', theme);
    const snapshot = createPrefs(storage); // reload view
    assert.equal(snapshot.get('theme'), theme);
    assert.equal(snapshot.get('displayName'), 'Ada', 'display name survives a theme switch');
    assert.equal(snapshot.get('textSize'), 'lg', 'text size survives a theme switch');
  }
});

test('applyPrefs: switching to every theme toggles appearance attributes and browser chrome', () => {
  const dom = new JSDOM('<!doctype html><html data-theme="black" data-accent="violet" data-text="md" data-motion="full"><head><meta name="theme-color" content="#000000"></head><body></body></html>');
  globalThis.document = dom.window.document;
  try {
    for (const theme of THEMES) {
      applyPrefs(normalizePrefs({ theme, accent: 'blue', textSize: 'lg', reduceMotion: true }));
      const d = { ...dom.window.document.documentElement.dataset };
      assert.deepEqual(d, { theme, accent: 'blue', text: 'lg', motion: 'reduce' }, `dataset for ${theme}`);
      assert.equal(
        dom.window.document.querySelector('meta[name="theme-color"]').content,
        THEME_COLOR[theme], `meta theme-color for ${theme}`,
      );
    }
  } finally {
    dom.window.close();
    delete globalThis.document;
  }
});

test('theme selection UI: the settings screen offers exactly the three themes with preview swatches', () => {
  const html = read('index.html');
  const picker = /<div class="theme-picker"[\s\S]*?<\/div>\s*<span class="row-sub" id="theme-note"/.exec(html)?.[0];
  assert.ok(picker, 'theme-picker markup exists before the #theme-note status line');
  assert.deepEqual([...picker.matchAll(/data-value="(\w+)"/g)].map((m) => m[1]), THEMES, 'picker lists the themes in order');
  assert.deepEqual([...picker.matchAll(/data-swatch="(\w+)"/g)].map((m) => m[1]), THEMES, 'each theme has a preview swatch');
  const css = read('src/css/components.css');
  for (const theme of THEMES) assert.match(css, new RegExp(`\\.theme-preview\\[data-swatch="${theme}"\\]`), `swatch styled for ${theme}`);
});

test('anti-flash boot script: the head script knows every theme and matches THEME_COLOR', () => {
  const html = read('index.html');
  const script = /<script>\s*\/\*[\s\S]*?first paint[\s\S]*?<\/script>/.exec(html)?.[0];
  assert.ok(script, 'an inline boot script applies the saved appearance before first paint');
  assert.ok(script.includes('nyx.prefs'), 'reads the same storage key as the app');
  assert.ok(script.includes('localStorage') && script.includes('try {'), 'guards against blocked storage');
  for (const theme of THEMES) {
    assert.ok(script.includes(`'${theme}'`), `boot script accepts ${theme}`);
    assert.ok(script.includes(THEME_COLOR[theme]), `boot script chrome colour for ${theme} matches settings.js`);
  }
});

// ── CSS architecture guards ──────────────────────────────────────────────────

test('colour safety: no hardcoded colours outside variables.css', () => {
  // Theme-picker preview swatches deliberately picture fixed theme colours — allow those rules.
  const isSwatchRule = (selector) => /\.theme-preview|\.tp-/.test(selector);
  for (const file of ['src/css/base.css', 'src/css/layout.css', 'src/css/components.css']) {
    const css = read(file);
    for (const rule of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      if (isSwatchRule(rule[1])) continue;
      assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(rule[2]), `${file} ${rule[1].trim()} contains a hardcoded hex colour`);
      assert.ok(!/\brgba?\(/.test(rule[2]), `${file} ${rule[1].trim()} contains a hardcoded rgb()/rgba()`);
    }
  }
});

test('chrome consistency: color-scheme follows the theme for scrollbars and form parts', () => {
  const css = read('src/css/variables.css');
  assert.match(css, /:root\s*\{[^}]*color-scheme:\s*dark/, 'dark is the default colour scheme');
  assert.match(css, /:root\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light/, 'Light sets a light colour scheme');
  assert.match(read('index.html'), /<meta name="color-scheme" content="dark light">/);
});
