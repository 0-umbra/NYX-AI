/**
 * Tiny dependency-free syntax highlighter. Output is HTML-escaped; tokens are wrapped in
 * <span class="tok-*"> (c=comment, s=string, k=keyword, f=function/property, n=number).
 * Unknown languages are returned escaped but unstyled.
 */
import { escapeHtml } from './util.js';

const kw = (list) => String.raw`\b(?:${list.trim().split(/\s+/).join('|')})\b`;
const NUM = String.raw`\b0x[\da-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b`;
const STR = String.raw`"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|\x60(?:\\.|[^\x60\\])*\x60?`;
const FUNC = String.raw`\b[A-Za-z_$][\w$]*(?=\()`;
const SLASH_COMMENT = String.raw`//[^\n]*|/\*[\s\S]*?(?:\*/|$)`;

const JS = kw(`const let var function return if else for while do switch case break continue new class extends super
  import from export default async await try catch finally throw typeof instanceof in of delete void yield static
  null true false undefined this`);
const PY = kw(`def class return if elif else for while in not and or is import from as with try except finally raise
  pass break continue lambda yield global nonlocal None True False async await self`);
const SH = kw(`if then else elif fi for do done while until case esac function in echo cd ls cat export source sudo
  npm npx node git pkg mkdir rm cp mv curl`);

const DEFS = {
  js: [['c', SLASH_COMMENT], ['s', STR], ['k', JS], ['f', FUNC], ['n', NUM]],
  py: [['c', String.raw`#[^\n]*`], ['s', String.raw`"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|${STR}`], ['k', PY], ['f', FUNC], ['n', NUM]],
  sh: [['c', String.raw`#[^\n]*`], ['s', STR], ['k', SH], ['n', NUM]],
  json: [['s', STR], ['k', kw('true false null')], ['n', NUM]],
  css: [['c', String.raw`/\*[\s\S]*?(?:\*/|$)`], ['s', STR], ['k', String.raw`@[\w-]+`], ['f', String.raw`[\w-]+(?=\s*:)`],
        ['n', String.raw`#[\da-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|ms|s|%)?`]],
  html: [['c', String.raw`<!--[\s\S]*?(?:-->|$)`], ['s', STR], ['k', String.raw`</?[A-Za-z][\w-]*|/?>`], ['f', String.raw`[\w:-]+(?==)`]],
};

const ALIASES = {
  javascript: 'js', jsx: 'js', mjs: 'js', ts: 'js', typescript: 'js', tsx: 'js',
  python: 'py', py: 'py',
  bash: 'sh', shell: 'sh', sh: 'sh', zsh: 'sh', termux: 'sh', console: 'sh',
  json: 'json', jsonc: 'json',
  css: 'css', html: 'html', xml: 'html', svg: 'html', js: 'js',
};

const compiled = new Map();
function compile(key) {
  if (!compiled.has(key)) {
    const rules = DEFS[key];
    compiled.set(key, { rules, re: new RegExp(rules.map(([, src]) => `(${src})`).join('|'), 'g') });
  }
  return compiled.get(key);
}

export function resolveLanguage(lang) {
  return ALIASES[String(lang || '').toLowerCase()] ?? null;
}

export function highlight(code, lang = '') {
  const text = String(code ?? '');
  const key = resolveLanguage(lang);
  if (!key) return escapeHtml(text);
  const { rules, re } = compile(key);
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '') { re.lastIndex++; continue; }
    const group = m.findIndex((v, i) => i > 0 && v !== undefined) - 1;
    out += escapeHtml(text.slice(last, m.index));
    out += `<span class="tok-${rules[group][0]}">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}
