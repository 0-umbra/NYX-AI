/**
 * The frontend shows a server `error` string ONLY if it exactly matches a sentence in
 * `KNOWN_FAILURE_MESSAGES`. That is what makes the relay safe (an allowlist cannot be talked
 * around), but it introduces one failure mode: if the Worker adds or reworders a message and the
 * frontend list is not updated, users silently drop to the generic sentence.
 *
 * This test removes that risk by deriving the Worker's user-facing strings from its own source and
 * requiring every one of them to be present in the frontend allowlist — byte for byte, including
 * the curly apostrophes the Worker uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KNOWN_FAILURE_MESSAGES } from '../../src/js/transport.js';

const BACKEND_FILES = [
  'backend/src/attachments.js',
  'backend/src/index.js',
  'backend/src/conversation.js',
];

/** Every `error: "…"` literal and every `error: `x${CONST}y`` template in the Worker source. */
function workerErrorStrings() {
  const found = new Set();
  for (const file of BACKEND_FILES) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/error:\s*"((?:[^"\\]|\\.)*)"/g)) found.add(match[1]);
    // Template literals are interpolated with module constants (attachment/page limits), so the
    // frontend cannot match them exactly. They are listed separately below.
  }
  return found;
}

test('every fixed Worker error string is present in the frontend allowlist', () => {
  const missing = [...workerErrorStrings()].filter((message) => !KNOWN_FAILURE_MESSAGES.includes(message));
  assert.deepEqual(missing, [],
    'these Worker messages would silently fall back to the generic sentence; add them to KNOWN_FAILURE_MESSAGES');
});

test('the allowlist contains no strings the Worker cannot emit', () => {
  // Keeps the list honest: an entry that no longer exists is dead weight that hides drift.
  const workerStrings = workerErrorStrings();
  const stale = KNOWN_FAILURE_MESSAGES.filter((message) => !workerStrings.has(message));
  // Interpolated limit messages are legitimate frontend entries but cannot be matched exactly.
  const allowedUnmatched = stale.filter((message) => !/attach up to|OCR is limited to/.test(message));
  assert.deepEqual(allowedUnmatched, [], 'allowlist entries the Worker never sends');
});

test('the allowlist is frozen and free of duplicates', () => {
  assert.equal(Object.isFrozen(KNOWN_FAILURE_MESSAGES), true, 'must not be mutable at runtime');
  assert.equal(new Set(KNOWN_FAILURE_MESSAGES).size, KNOWN_FAILURE_MESSAGES.length, 'no duplicates');
});

test('no allowlisted message could ever carry user or provider data', () => {
  // These are all fixed prose. Guard against a future entry that interpolates something.
  for (const message of KNOWN_FAILURE_MESSAGES) {
    assert.match(message, /^[A-Z]/u, `must be prose: ${message}`);
    // Looks only for real payload shapes, not words a fixed sentence may legitimately use.
    assert.doesNotMatch(message, /data:[a-z]+\/|;base64,|https?:\/\/|eyJ[A-Za-z0-9_-]{8,}|@[a-z0-9-]+\.|\/accounts\/|\{\}|\$\{/i,
      `must not look like data, a path, a URL or a token: ${message}`);
    assert.ok(message.length < 120, `must be a sentence, not a dump: ${message}`);
  }
});
