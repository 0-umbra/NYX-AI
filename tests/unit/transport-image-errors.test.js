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
