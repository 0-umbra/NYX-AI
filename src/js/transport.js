/**
 * NYX AI — Cloud Backend Transport.
 * Sends Firebase-authenticated requests to the Cloudflare Worker.
 */
import { BACKEND, LIMITS, isBackendConfigured } from './config.js';
import { getFirebaseIdToken } from './auth.js';
import { isModelAvailable } from './models.js';
import { buildConversationHistory, isSendableHistory } from './history.js';

const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * The ONLY user-visible messages that may originate from the server side of a failed request.
 *
 * The Worker's `error` string is never displayed. It is treated as untrusted input and used
 * solely as a lookup key in this table: an exact, whole-string match against a sentence this app
 * knows. Anything else — a provider error, a data URI, a file name, a prompt, a token, an edge
 * error page, a future message nobody added here — falls back to a fixed generic sentence.
 *
 * This replaces a pattern-based relay ("short, single-line, mentions a keyword") which was
 * bypassable: `AiError: 5004 Input image is invalid: data:image/jpeg;base64,…` and
 * `Invalid token: eyJ…` both satisfied it. An allowlist cannot be talked around, and it fails
 * closed: a new Worker message simply shows the generic sentence until it is added here.
 *
 * Wording must stay byte-identical to `visionFailureResponse()` and the route's own literals in
 * `backend/src/`, or the mapping silently degrades to the generic message.
 */
export const KNOWN_FAILURE_MESSAGES = Object.freeze([
  // attachments (backend/src/attachments.js — visionFailureResponse + validation)
  'That image is too large to analyse. Try a smaller one.',
  'That image could not be analysed. Try a different image.',
  'Image understanding is busy right now. Please try again in a moment.',
  'Image understanding is temporarily unavailable.',
  'Image understanding is unavailable on the current Cloudflare plan.',
  'An attached image is too large.',
  'An attached image is not valid base64 data.',
  'An attached image is empty.',
  "An attached image's contents do not match its file type.",
  "An attached image's file type does not match its data.",
  'An attachment has an unsupported type.',
  'An attachment is missing a valid file name.',
  'Attachments must be a list.',
  'Invalid attachment format.',
  'A document attachment is missing its extracted text.',
  'A document attachment has an unsupported type.',
  'A document attachment contained no readable text.',
  'An attached document is too large to analyse.',
  'The attached documents are too large to analyse together.',
  // request limits
  'Request is too large.',
  'Conversation is too large.',
  'Invalid conversation length.',
  'Invalid conversation identifier.',
  'Invalid message format.',
  'The latest message must be from the user.',
  'JSON content type required.',
  // service state
  'Chat service is not configured.',
  'Chat service is temporarily unavailable.',
  'The AI service is temporarily unavailable. Please try again later.',
  'The AI returned an empty response.',
  'This model tier is not available yet.',
  'Too many requests. Please wait before trying again.',
  'Authentication required. Please sign in again.',
  'Invalid JSON request.',
  'Route not found.',
  'Method not allowed.',
  'Origin not allowed.',
  // vision failures whose own wording the app shows verbatim
  'NYX AI couldn\u2019t read that image. Try a different image.',
  "NYX AI couldn't analyse an attached image. Please try again later.",
  // the quota sentence also has a dedicated constant; listed so the derivation test passes
  'The free daily AI quota is exhausted. It resets at 00:00 UTC.',
]);

/** Error message shown when the Worker reports the free daily Workers AI allocation is exhausted. */
export const QUOTA_EXHAUSTED_MESSAGE = 'The free daily AI quota is exhausted. It resets at 00:00 UTC.';

function getEndpoint() {
  if (!isBackendConfigured()) {
    throw new Error('Cloud chat is not configured yet.');
  }

  const base = BACKEND.baseUrl.trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) {
    throw new Error('Invalid backend configuration.');
  }

  return `${base}/chat`;
}

/**
 * Turns a failed /chat response into a message the user can act on.
 *
 * The Worker already answers with a sanitized, user-safe `error` string; the frontend used to
 * discard it and show a generic connection message, which made an image-processing failure
 * indistinguishable from being offline. Only the Worker's own bounded, fixed messages are
 * relayed (never a provider error, never anything unknown), so this cannot leak provider text.
 */
/**
 * Safe diagnostic for a failed request. Records the stage, the HTTP status and a fixed category
 * only — never the Firebase ID token, the request body, attachments, base64 data or raw provider
 * text. A network failure (no response at all) is distinct from a server-reported failure, which
 * is the distinction that makes an unreachable backend diagnosable on a device.
 */
function reportFailure(diagnostics, stage, category, status = null) {
  try {
    diagnostics?.record(stage, category, Number.isInteger(status) ? { status } : {});
  } catch {
    // Diagnostics must never replace the real failure. A failing sink is swallowed here rather
    // than escaping as an unhandled rejection on the next `await`.
  }
}

/** Maps a non-OK /chat response to a fixed category. Never derived from provider text. */
export function categoryForStatus(status) {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 413) return 'TOO_LARGE';
  if (status === 415) return 'UNSUPPORTED_MEDIA';
  if (status === 429) return 'RATE_LIMITED_OR_QUOTA';
  if (status >= 500) return 'SERVER_ERROR';
  if (status >= 400) return 'REQUEST_REJECTED';
  return 'UNEXPECTED_STATUS';
}

/** Marks an error whose `message` is safe and useful to show in the conversation. */
function userFacingError(message) {
  const error = new Error(message);
  error.userFacing = true;
  return error;
}

function messageForFailure(status, data) {
  const quota = data?.quotaExhausted === true || (status === 429 && typeof data?.error === 'string' && data.error.includes('quota'));
  if (quota) return QUOTA_EXHAUSTED_MESSAGE;
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 429) return 'Too many requests. Please wait a moment and try again.';
  // The server's text is a lookup key, never a message. Only an exact match against a sentence
  // this app ships is shown; anything else keeps the generic sentence.
  const reported = typeof data?.error === 'string' ? data.error.trim() : '';
  if (reported && KNOWN_FAILURE_MESSAGES.includes(reported)) return reported;
  return 'The AI service couldn’t respond. Please try again.';
}

async function readResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw userFacingError('The reply couldn’t be completed. Check your connection and try again.');

  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw userFacingError('Backend response exceeded the allowed size.');
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
}

/**
 * Sends the conversation (plus any ready attachments) to the Worker and yields the reply text.
 * The generator's return value carries `{ attachmentResults }` — the per-image analyses the
 * Worker produced — so callers can persist them for follow-up context. Chat stubs in tests
 * yield plain strings and return nothing, which is handled gracefully.
 */
export async function* createTransport({
  conversationId,
  messages,
  model,
  attachments,
  signal
}, { getToken = getFirebaseIdToken, fetchRequest = fetch, diagnostics = null } = {}) {
  if (signal?.aborted) {
    throw new DOMException('Request cancelled.', 'AbortError');
  }

  if (!isModelAvailable(model)) throw new Error('This model tier is not available yet.');

  // Defence in depth: the chat view already builds bounded history, but the transport never
  // forwards notices, blank turns, oversized content or a list that does not end with the user.
  const safeMessages = buildConversationHistory(messages);
  if (!isSendableHistory(safeMessages)) {
    throw new Error('There is no message to send yet.');
  }

  const token = await getToken();
  const endpoint = getEndpoint();

  const payload = { conversationId, model, messages: safeMessages };
  if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;

  const bodyJson = JSON.stringify(payload);
  if (new TextEncoder().encode(bodyJson).length > LIMITS.maxRequestBytes) {
    // Never put an oversized request on the wire; the Worker would refuse it anyway.
    throw new Error('The attachments are too large to send together. Remove one and try again.');
  }

  let response;
  try {
    response = await fetchRequest(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: bodyJson,
      signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    // No response at all: DNS, TLS, radio, timeout or the Worker being unreachable/killed.
    reportFailure(diagnostics, payload.attachments ? 'transport.attachments' : 'transport.chat', 'NETWORK_ERROR');
    throw error;
  }

  // The response body is read before the status is inspected, because the Worker always explains
  // a failure in JSON. A non-JSON body therefore means the request never reached application code
  // (an edge error or a killed isolate), which is reported as such rather than as a parse failure.
  const raw = await readResponse(response);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    reportFailure(diagnostics, payload.attachments ? 'transport.attachments' : 'transport.chat', 'NON_JSON_BODY', response.status);
    throw userFacingError(
      response.ok
        ? 'The backend returned an invalid response.'
        : 'The AI service couldn’t respond. Please try again.'
    );
  }

  if (!response.ok) {
    const category = categoryForStatus(response.status);
    reportFailure(diagnostics, payload.attachments ? 'transport.attachments' : 'transport.chat', category, response.status);
    throw userFacingError(messageForFailure(response.status, data));
  }

  if (typeof data.reply !== 'string' || !data.reply.trim()) {
    reportFailure(diagnostics, 'transport.reply', 'EMPTY_REPLY', response.status);
    throw userFacingError('The backend returned an empty response.');
  }

  yield data.reply;
  return { attachmentResults: Array.isArray(data.attachmentResults) ? data.attachmentResults : undefined };
}
