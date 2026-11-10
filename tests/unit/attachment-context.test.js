/**
 * History tests for attachment-aware conversation context. The Worker is stateless, so the
 * extracted content of attachments (image analyses, document text — persisted on-device at send
 * time) must travel inside the turns that carry them, bounded by the same history limits.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConversationHistory, toChatMessage, attachmentContextBlock, HISTORY_LIMITS,
} from '../../src/js/history.js';

const user = (content, attachments, id = Math.random().toString(36).slice(2)) => ({ id, role: 'user', content, attachments });
const imageAttachment = (over = {}) => ({
  name: 'screenshot.png', size: 20480, type: 'image/png', kind: 'image',
  analysis: 'A login form with email and password fields and a blue submit button.',
  ...over,
});
const docAttachment = (over = {}) => ({
  name: 'report.pdf', size: 40960, type: 'application/pdf', kind: 'document',
  extractedText: 'Quarterly revenue grew 12% year over year to 4.2 million. Churn fell to 3%.',
  ...over,
});

test('attachmentContextBlock: image analysis folds in under a labelled block', () => {
  const block = attachmentContextBlock({ role: 'user', content: '', attachments: [imageAttachment()] });
  assert.match(block, /^\[Attached image "screenshot\.png": A login form/);
  assert.match(block, /blue submit button\.\]$/);
});

test('attachmentContextBlock: document text folds in under a labelled block', () => {
  const block = attachmentContextBlock({ role: 'user', content: '', attachments: [docAttachment()] });
  assert.match(block, /^\[Attached document "report\.pdf": Quarterly revenue/);
});

test('attachmentContextBlock: filenames alone never become model context', () => {
  const block = attachmentContextBlock({ role: 'user', content: '', attachments: [{ name: 'secret.pdf', size: 1, type: 'application/pdf', kind: 'document' }] });
  assert.equal(block, '');
  const block2 = attachmentContextBlock({ role: 'user', content: '', attachments: [{ name: 'pic.png', kind: 'image' }] });
  assert.equal(block2, '');
});

test('toChatMessage: a blank user turn with analysed attachments still carries context', () => {
  const message = toChatMessage(user('', [imageAttachment()]));
  assert.ok(message, 'context-only turn is sendable');
  assert.equal(message.role, 'user');
  assert.match(message.content, /login form/);
});

test('toChatMessage: a blank user turn with only metadata is dropped as before', () => {
  const message = toChatMessage(user('', [{ name: 'notes.pdf', size: 10, type: 'application/pdf', kind: 'document' }]));
  assert.equal(message, null);
});

test('toChatMessage: user text comes first, context block appended, order preserved', () => {
  const message = toChatMessage(user('What is in this screenshot?', [imageAttachment()]));
  assert.equal(message.role, 'user');
  assert.match(message.content, /^What is in this screenshot\?\n\[Attached image /);
});

test('toChatMessage: attachment context is bounded — huge analyses are truncated', () => {
  const message = toChatMessage(user('short question', [imageAttachment({ analysis: 'x'.repeat(5000) })]));
  assert.ok(message.content.length <= HISTORY_LIMITS.maxMessageChars);
  assert.match(message.content, /^short question/);
});

test('toChatMessage: when text + blocks exceed the cap the user text is trimmed first', () => {
  const message = toChatMessage(user('q'.repeat(3000), [docAttachment({ extractedText: 'd'.repeat(3000) })]));
  assert.ok(message.content.length <= HISTORY_LIMITS.maxMessageChars);
  assert.match(message.content, /\[Attached document "report\.pdf":/);
});

test('buildConversationHistory: folded context survives into the sent history', () => {
  const history = buildConversationHistory([
    user('Summarise this PDF.', [docAttachment()], 'm1'),
    { id: 'a1', role: 'assistant', content: 'It reports revenue growth of 12%.' },
    user('What was the growth figure?', undefined, 'm2'),
  ]);
  const folded = history[0];
  assert.match(folded.content, /Summarise this PDF\./);
  assert.match(folded.content, /Attached document "report\.pdf"/);
  assert.equal(history.at(-1).content, 'What was the growth figure?');
});

test('buildConversationHistory: context blocks count towards the total budget', () => {
  const messages = [];
  for (let i = 0; i < 8; i++) {
    messages.push(user(`question ${i} ${'x'.repeat(1500)}`, [docAttachment({ name: `doc-${i}.pdf`, extractedText: `d${i} `.repeat(600) })], `u${i}`));
    messages.push({ id: `a${i}`, role: 'assistant', content: `answer ${i} ${'y'.repeat(1500)}` });
  }
  messages.push(user('latest question', undefined, 'last'));
  const history = buildConversationHistory(messages);
  const total = history.reduce((n, m) => n + m.content.length, 0);
  assert.ok(total <= HISTORY_LIMITS.maxTotalChars, `total ${total}`);
  assert.equal(history.at(-1).content, 'latest question');
});

test('buildConversationHistory: several analysed images in one message all reach the model', () => {
  const history = buildConversationHistory([
    user('Compare these screenshots.', [
      imageAttachment({ name: 'one.png', analysis: 'first shows a red dialog' }),
      imageAttachment({ name: 'two.png', analysis: 'second shows a green dialog' }),
    ]),
  ]);
  assert.equal(history.length, 1);
  assert.match(history[0].content, /one\.png/);
  assert.match(history[0].content, /two\.png/);
  assert.match(history[0].content, /red dialog/);
  assert.match(history[0].content, /green dialog/);
});
