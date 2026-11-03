import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderInline } from '../../src/js/markdown.js';
import { highlight, resolveLanguage } from '../../src/js/highlight.js';

test('escapes raw HTML (XSS)', () => {
  const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('only http(s) and mailto links become anchors', () => {
  assert.match(renderInline('[ok](https://example.com/a_b_c)'), /<a href="https:\/\/example\.com\/a_b_c" target="_blank" rel="noopener noreferrer">ok<\/a>/);
  assert.ok(!renderInline('[bad](javascript:alert(1))').includes('<a '));
  assert.ok(!renderInline('[bad](data:text/html;base64,AAAA)').includes('<a '));
  assert.ok(renderInline('[mail](mailto:a@b.co)').includes('<a href="mailto:a@b.co"'));
});

test('quotes in link URLs cannot break out of the attribute', () => {
  const html = renderInline('[x](https://a.com/"onmouseover="alert(1))');
  assert.ok(html.includes('&quot;onmouseover=&quot;'));
  assert.ok(!html.includes('"onmouseover="'));
});

test('inline formatting', () => {
  assert.equal(renderInline('**b** *i* ~~s~~ `c`'), '<strong>b</strong> <em>i</em> <del>s</del> <code>c</code>');
  assert.equal(renderInline('`<b>`'), '<code>&lt;b&gt;</code>');
  assert.equal(renderInline('snake_case_name'), 'snake_case_name');
});

test('headings, rules and paragraphs', () => {
  assert.equal(renderMarkdown('# Title'), '<h2>Title</h2>');
  assert.equal(renderMarkdown('## Sub'), '<h3>Sub</h3>');
  assert.equal(renderMarkdown('a\nb'), '<p>a<br>b</p>');
  assert.equal(renderMarkdown('---'), '<hr>');
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
});

test('lists: nesting and ordered/unordered switching', () => {
  const html = renderMarkdown('- a\n  - nested\n- b\n\n1. one\n2. two');
  assert.equal(html, '<ul><li>a<ul><li>nested</li></ul></li><li>b</li></ul><ol><li>one</li><li>two</li></ol>');
  assert.ok(renderMarkdown('3. x\n4. y').startsWith('<ol start="3">'));
});

test('blockquotes and tables', () => {
  assert.equal(renderMarkdown('> quote'), '<blockquote><p>quote</p></blockquote>');
  const t = renderMarkdown('| a | b |\n|---|:-:|\n| 1 | 2 |');
  assert.match(t, /<div class="table-wrap"><table><thead>/);
  assert.match(t, /<th style="text-align:center">b<\/th>/);
});

test('fenced code blocks are highlighted, escaped and copyable', () => {
  const html = renderMarkdown('```js\nconst a = "<x>"; // hi\n```');
  assert.match(html, /class="code-block"/);
  assert.match(html, /data-copy-code/);
  assert.match(html, /<span class="tok-k">const<\/span>/);
  assert.match(html, /<span class="tok-c">\/\/ hi<\/span>/);
  assert.ok(!html.includes('<x>'));
});

test('unclosed code fence (streaming) renders as code', () => {
  const html = renderMarkdown('text\n\n```py\nprint("hi")');
  assert.match(html, /class="code-block"/);
  assert.match(html, /tok-f/);
});

test('highlighter: languages, aliases and unknown languages', () => {
  assert.equal(resolveLanguage('TypeScript'), 'js');
  assert.equal(resolveLanguage('termux'), 'sh');
  assert.equal(resolveLanguage('klingon'), null);
  assert.equal(highlight('a < b', 'klingon'), 'a &lt; b');
  assert.match(highlight('{"a": true, "b": 1}', 'json'), /tok-k">true<.*tok-n">1</s);
  assert.match(highlight('# c\necho "x"', 'bash'), /tok-c">#/);
  assert.match(highlight('<a href="x">', 'html'), /tok-k/);
  assert.match(highlight('.a { color: #fff; }', 'css'), /tok-f">color/);
  assert.equal(highlight('', 'js'), '');
});
