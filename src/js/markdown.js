/**
 * Small, safe Markdown renderer for chat messages (no dependencies).
 * All text is HTML-escaped before any markup is produced; links are limited to http(s) and mailto.
 * Supports: headings, paragraphs, bold/italic/strikethrough, inline code, fenced code blocks (highlighted),
 * links, blockquotes, nested ordered/unordered lists, tables, horizontal rules.
 * Unclosed code fences (streaming) render as code until the end of the text.
 */
import { escapeHtml } from './util.js';
import { highlight } from './highlight.js';

const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/;
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const HEADING_RE = /^(#{1,4})\s+(.+?)\s*#*\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function emphasis(s) {
  return s
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+?)~~/g, '<del>$1</del>')
    .replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?!\w)/g, '$1<em>$2</em>');
}

export function renderInline(text) {
  const codes = [];
  const links = [];
  let s = String(text).replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = escapeHtml(s);
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) =>
    SAFE_URL.test(url) ? `\u0001${links.push({ label, url }) - 1}\u0001` : m);
  s = emphasis(s);
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => {
    const { label, url } = links[i];
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${emphasis(label)}</a>`;
  });
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[i])}</code>`);
}

function codeBlock(code, lang) {
  const label = escapeHtml((lang || 'text').toLowerCase());
  return `<div class="code-block"><div class="code-head"><span class="code-lang">${label}</span>`
    + `<button type="button" class="code-copy" data-copy-code aria-label="Copy code">Copy</button></div>`
    + `<pre tabindex="0"><code>${highlight(code, lang)}</code></pre></div>`;
}

const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

function isBlockStart(line, next) {
  return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || /^\s*>/.test(line) || LIST_RE.test(line)
    || (line.includes('|') && next !== undefined && TABLE_SEP_RE.test(next) && next.includes('-'));
}

export function renderMarkdown(src) {
  const text = String(src ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000\u0001]/g, '');
  const lines = text.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    let m = FENCE_RE.exec(line);
    if (m) {
      const [, fence, lang] = m;
      const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
      const buf = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(codeBlock(buf.join('\n'), lang));
      continue;
    }
    if (!line.trim()) { i++; continue; }

    if ((m = HEADING_RE.exec(line))) {
      const level = Math.min(m[1].length + 1, 5);
      out.push(`<h${level}>${renderInline(m[2])}</h${level}>`);
      i++; continue;
    }
    if (HR_RE.test(line)) { out.push('<hr>'); i++; continue; }

    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*> ?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : 'left'));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      const cell = (tag, c, n) => `<${tag} style="text-align:${aligns[n] ?? 'left'}">${renderInline(c)}</${tag}>`;
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c, n) => cell('th', c, n)).join('')}</tr></thead>`
        + `<tbody>${rows.map((r) => `<tr>${head.map((_, n) => cell('td', r[n] ?? '', n)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }

    if ((m = LIST_RE.exec(line))) {
      const base = m[1].length;
      const ordered = /\d/.test(m[2]);
      const start = ordered ? parseInt(m[2], 10) : 1;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const lm = LIST_RE.exec(l);
        if (lm && lm[1].length === base && /\d/.test(lm[2]) === ordered) { items.push([lm[3]]); i++; continue; }
        if (items.length && l.startsWith(' '.repeat(base + 2)) && l.trim()) { items[items.length - 1].push(l.slice(base + 2)); i++; continue; }
        if (!l.trim() && items.length) {
          const next = lines.slice(i + 1).find((x) => x.trim());
          if (next !== undefined && ((LIST_RE.exec(next)?.[1].length === base) || next.startsWith(' '.repeat(base + 2)))) { i++; continue; }
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
      const lis = items.map((body) => {
        let html = renderMarkdown(body.join('\n'));
        if (/^<p>/.test(html) && html.indexOf('<p>', 3) === -1) html = html.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
        return `<li>${html}</li>`;
      });
      out.push(`<${tag}${startAttr}>${lis.join('')}</${tag}>`);
      continue;
    }

    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) buf.push(lines[i++]);
    out.push(`<p>${renderInline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('');
}
