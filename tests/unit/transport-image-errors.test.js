/**
 * Frontend regression tests for how a failed /chat request is reported.
 *
 * The production symptom this covers: an image attachment failed and the user saw only
 * "The reply couldn't be completed. Check your connection and try again." — indistinguishable
 * from being offline, with the Worker's own explanation discarded. These tests pin both halves of
 * the contract: a classified failure is shown as-is, and an unclassified one is never shown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransport, categoryForStatus, QUOTA_EXHAUSTED_MESSAGE } from '../../src/js/transport.js';

const okJson = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const request = (overrides = {}) => ({
  conversationId: 'c1',
  messages: [{ role: 'user', content: 'What is in this image?' }],
  model: 'free',
  attachments: [{ name: 'a.png', kind: 'image', mime: 'image/png', data: 'data:image/png;base64,AAAA' }],
  ...overrides,
});

/** Runs the generator to completion and returns the thrown error, if any. */
async function run({ fetchRequest, diagnostics = null, req = request() }) {
  const generator = createTransport(req, {
    getToken: async () => 'test-token',
    fetchRequest,
    diagnostics,
  });
  try {
    let step = await generator.next();
    while (!step.done) step = await generator.next();
    return { error: null };
  } catch (error) {
    return { error };
  }
}

const collector = () => {
  const records = [];
  return { records, record: (stage, category, details = {}) => records.push({ stage, category, ...details }) };
};

// --- success ----------------------------------------------------------------

test('a successful attachment request yields the reply and the per-image analyses', async () => {
  const { error } = await run({
    fetchRequest: async () => okJson({ reply: 'It is a diagram.', attachmentResults: [{ name: 'a.png', analysis: 'A box.' }] }),
  });
  assert.equal(error, null);
});

// --- backend-reported failures are surfaced ---------------------------------

test('the Worker’s attachment explanation is shown instead of a connection message', async () => {
  for (const [status, message] of [
    [413, 'That image is too large to analyse. Try a smaller one.'],
    [415, 'That image could not be analysed. Try a different image.'],
    [503, 'Image understanding is busy right now. Please try again in a moment.'],
    [502, 'NYX AI couldn’t read that image. Try a different image.'],
  ]) {
    const { error } = await run({ fetchRequest: async () => okJson({ error: message }, status) });
    assert.ok(error, `${status} throws`);
    assert.equal(error.userFacing, true, `${status} is user-facing`);
    assert.equal(error.message, message);
    assert.doesNotMatch(error.message, /Check your connection/);
  }
});

test('a quota response keeps the exact documented message and flag', async () => {
  const { error } = await run({
    fetchRequest: async () => okJson({ error: 'The free daily AI quota is exhausted. It resets at 00:00 UTC.', quotaExhausted: true }, 429),
  });
  assert.equal(error.message, QUOTA_EXHAUSTED_MESSAGE);
  assert.equal(error.userFacing, true);
});

test('session expiry and rate limiting keep their existing messages', async () => {
  const expired = await run({ fetchRequest: async () => okJson({ error: 'Authentication required.' }, 401) });
  assert.equal(expired.error.message, 'Your session has expired. Please sign in again.');
  const limited = await run({ fetchRequest: async () => okJson({ error: 'Too many requests.' }, 429) });
  assert.equal(limited.error.message, 'Too many requests. Please wait a moment and try again.');
});

test('a provider error string is never forwarded, even when the Worker echoes one', async () => {
  const leak = 'AiError: 5004 Invalid data at /accounts/secret-bucket';
  const { error } = await run({ fetchRequest: async () => okJson({ error: leak }, 502) });
  assert.ok(!error.message.includes('AiError'));
  assert.ok(!error.message.includes('secret-bucket'));
  assert.ok(error.message.length > 0);
});

test('an unknown or malformed error body falls back to a fixed message', async () => {
  for (const body of [{}, { error: 42 }, { error: null }, { error: 'x'.repeat(400) }, { error: 'line\nbreak' }, []]) {
    const { error } = await run({ fetchRequest: async () => okJson(body, 500) });
    assert.equal(error.message, 'The AI service couldn’t respond. Please try again.', JSON.stringify(body).slice(0, 40));
  }
});

// --- non-JSON bodies --------------------------------------------------------

test('a non-JSON error body is treated as an edge/runtime failure, not a parse bug', async () => {
  const { error } = await run({
    fetchRequest: async () => new Response('error code: 1102', { status: 500 }),
  });
  assert.equal(error.message, 'The AI service couldn’t respond. Please try again.');
  assert.equal(error.userFacing, true);
});

test('a non-JSON body on a 200 is reported as an invalid response', async () => {
  const { error } = await run({ fetchRequest: async () => new Response('<html>proxy</html>', { status: 200 }) });
  assert.equal(error.message, 'The backend returned an invalid response.');
});

test('an empty reply is reported rather than shown as a blank message', async () => {
  const { error } = await run({ fetchRequest: async () => okJson({ reply: '   ' }) });
  assert.equal(error.message, 'The backend returned an empty response.');
});

// --- network failures -------------------------------------------------------

test('a network failure is not marked user-facing and carries no HTTP status', async () => {
  const diagnostics = collector();
  const { error } = await run({
    fetchRequest: async () => { throw new TypeError('Failed to fetch'); },
    diagnostics,
  });
  assert.equal(error.name, 'TypeError');
  assert.notEqual(error.userFacing, true, 'a raw network error must not be shown as an explanation');
  assert.deepEqual(diagnostics.records[0], { stage: 'transport.attachments', category: 'NETWORK_ERROR' });
});

test('an abort is rethrown untouched and is not recorded as a failure', async () => {
  const diagnostics = collector();
  const abort = Object.assign(new Error('Request cancelled.'), { name: 'AbortError' });
  const { error } = await run({ fetchRequest: async () => { throw abort; }, diagnostics });
  assert.equal(error.name, 'AbortError');
  assert.deepEqual(diagnostics.records, []);
});

// --- diagnostics ------------------------------------------------------------

test('diagnostics record the stage, the status code and a fixed category', async () => {
  for (const [status, expected] of [
    [401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [413, 'TOO_LARGE'], [415, 'UNSUPPORTED_MEDIA'],
    [429, 'RATE_LIMITED_OR_QUOTA'], [500, 'SERVER_ERROR'], [502, 'SERVER_ERROR'], [400, 'REQUEST_REJECTED'],
  ]) {
    assert.equal(categoryForStatus(status), expected, String(status));
    const diagnostics = collector();
    await run({ fetchRequest: async () => okJson({ error: 'sanitized worker message' }, status), diagnostics });
    assert.deepEqual(diagnostics.records[0], {
      stage: 'transport.attachments',
      category: expected,
      status,
    });
  }
});

test('diagnostics use the chat stage when there are no attachments', async () => {
  const diagnostics = collector();
  await run({ fetchRequest: async () => okJson({ error: 'x' }, 500), diagnostics, req: request({ attachments: undefined }) });
  assert.equal(diagnostics.records[0].stage, 'transport.chat');
  assert.equal(diagnostics.records[0].status, 500);
});

test('diagnostics never contain the token, the payload, the attachment data or provider text', async () => {
  const diagnostics = collector();
  const secretMessage = 'AiError: invalid base64 for data:image/png;base64,AAAA at bucket abc';
  await run({
    diagnostics,
    fetchRequest: async () => okJson({ error: secretMessage }, 400),
  });
  const serialized = JSON.stringify(diagnostics.records);
  for (const forbidden of ['test-token', 'data:image/png', 'AAAA', 'bucket abc', 'AiError', 'What is in this image']) {
    assert.ok(!serialized.includes(forbidden), `diagnostics leaked ${JSON.stringify(forbidden)}`);
  }
  assert.deepEqual(Object.keys(diagnostics.records[0]).sort(), ['category', 'stage', 'status']);
});

test('diagnostics are never emitted for a successful request', async () => {
  const diagnostics = collector();
  await run({ diagnostics, fetchRequest: async () => okJson({ reply: 'fine' }) });
  assert.deepEqual(diagnostics.records, []);
});

test('a diagnostics sink that throws cannot break the reply or the error', async () => {
  const hostile = { record() { throw new Error('sink exploded'); } };
  const failed = await run({ diagnostics: hostile, fetchRequest: async () => okJson({ error: 'nope' }, 500) });
  assert.equal(failed.error.message, 'The AI service couldn’t respond. Please try again.');
  const networked = await run({ diagnostics: hostile, fetchRequest: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(networked.error.message, 'Failed to fetch');
});

// --- oversized responses ----------------------------------------------------

test('an oversized backend response is bounded and reported', async () => {
  const big = JSON.stringify({ reply: 'x'.repeat(70 * 1024) });
  const { error } = await run({ fetchRequest: async () => new Response(big, { status: 200 }) });
  assert.equal(error.message, 'Backend response exceeded the allowed size.');
});

// --- adversarial: relayed text can never carry user or provider data ---------------------------
//
// The relay used to accept any Worker `error` string that was short, single-line and contained a
// relevant keyword. Probed with realistic payloads, strings such as
//   `AiError: 5004 Input image is invalid: data:image/jpeg;base64,/9j/...`
// and `Invalid token: eyJhbGci...` passed all three gates. That was only safe because the Worker
// happens to write fixed literals — safety must not depend on the server's good behaviour.

/**
 * Every sentence the app itself may show for a failed request. Any message outside this set means
 * server-authored text reached the screen.
 */
const FIXED_MESSAGES = [
  'That image is too large to analyse. Try a smaller one.',
  'That image could not be analysed. Try a different image.',
  'Image understanding is busy right now. Please try again in a moment.',
  'Image understanding is temporarily unavailable.',
  'Image understanding is unavailable on the current Cloudflare plan.',
  'NYX AI couldn\u2019t read that image. Try a different image.',
  "NYX AI couldn't analyse an attached image. Please try again later.",
  'The AI service couldn\u2019t respond. Please try again.',
  'Your session has expired. Please sign in again.',
  'Too many requests. Please wait a moment and try again.',
];

/** Everything a leaked message could contain, gathered once. */
const LEAKY_STRINGS = {
  dataUri: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL',
  base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  filename: 'my-passport-scan.jpg',
  prompt: 'what is the passport number of John Smith',
  jwt: 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImsifQ.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl',
  providerCode: 'AiError: 5004 Invalid data type',
  bucket: '/accounts/secret-bucket',
};

test('adversarial: a data-URI or base64 payload in the error field is never shown', async () => {
  for (const body of [
    { error: `AiError: 5004 Input image is invalid: ${LEAKY_STRINGS.dataUri}` },
    { error: `failed to decode image: ${LEAKY_STRINGS.base64}` },
    { error: `That image could not be analysed: ${LEAKY_STRINGS.dataUri}` },
  ]) {
    const { error } = await run({ fetchRequest: async () => okJson(body, 415) });
    // Untrusted text never becomes the message; a fixed sentence from the app's own set does.
    assert.ok(FIXED_MESSAGES.includes(error.message), `unexpected message: ${error.message}`);
    assert.equal(error.userFacing, true);
    for (const leak of [LEAKY_STRINGS.dataUri, '/9j/4AAQ', 'iVBORw0KGgo', 'base64']) {
      assert.equal(error.message.includes(leak), false, `must not include ${leak.slice(0, 12)}`);
    }
  }
});

test('adversarial: a filename or prompt in the error field is never shown', async () => {
  for (const body of [
    { error: `Could not read ${LEAKY_STRINGS.filename}` },
    { error: `The file ${LEAKY_STRINGS.filename} contains ${LEAKY_STRINGS.prompt}` },
    { error: `attachment ${LEAKY_STRINGS.filename} is too large` },
  ]) {
    const { error } = await run({ fetchRequest: async () => okJson(body, 413) });
    assert.ok(FIXED_MESSAGES.includes(error.message), `unexpected message: ${error.message}`);
    assert.equal(error.message.includes(LEAKY_STRINGS.filename), false);
    assert.equal(error.message.includes('passport'), false);
    assert.equal(error.message.includes('John Smith'), false);
  }
});

test('adversarial: a JWT-shaped string in the error field is never shown', async () => {
  for (const body of [
    { error: `Invalid token: ${LEAKY_STRINGS.jwt}` },
    { error: `Bearer ${LEAKY_STRINGS.jwt} rejected` },
  ]) {
    const { error } = await run({ fetchRequest: async () => okJson(body, 401) });
    assert.equal(error.message, 'Your session has expired. Please sign in again.');
    assert.equal(error.message.includes('eyJ'), false);
  }
});

test('adversarial: every status maps to a fixed message, never the server string', async () => {
  // Exhaustive over the statuses the Worker and its edge can return. Each must produce one of the
  // app's own fixed sentences, so no server-authored text can reach the screen.
  const seen = new Set();
  for (const status of [400, 401, 403, 404, 408, 413, 415, 422, 429, 500, 502, 503, 504]) {
    const { error } = await run({
      fetchRequest: async () => okJson({ error: `${LEAKY_STRINGS.filename} ${LEAKY_STRINGS.dataUri}` }, status),
    });
    assert.ok(error, `${status} throws`);
    assert.equal(error.userFacing, true);
    assert.equal(error.message.includes('passport'), false, `${status} must not leak the filename`);
    assert.equal(error.message.includes('data:image'), false, `${status} must not leak the data URI`);
    seen.add(error.message);
  }
  // A small, closed set of messages — not one per status.
  assert.ok(seen.size <= 6, `expected a fixed message set, saw ${seen.size}`);
});

test('adversarial: nothing user-derived is ever logged for a failed request', async () => {
  const diagnostics = collector();
  await run({
    diagnostics,
    fetchRequest: async () => okJson({ error: `${LEAKY_STRINGS.filename} ${LEAKY_STRINGS.jwt}` }, 415),
  });
  const logged = JSON.stringify(diagnostics.records);
  for (const leak of [LEAKY_STRINGS.filename, LEAKY_STRINGS.jwt, LEAKY_STRINGS.dataUri, 'eyJ']) {
    assert.equal(logged.includes(leak), false, `diagnostics must not log ${leak.slice(0, 12)}`);
  }
  // Only fixed categories and a numeric status are recorded.
  assert.deepEqual(diagnostics.records, [{ stage: 'transport.attachments', category: 'UNSUPPORTED_MEDIA', status: 415 }]);
});
