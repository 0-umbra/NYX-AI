/**
 * NYX AI — Cloud Backend Transport.
 * Sends Firebase-authenticated requests to the Cloudflare Worker.
 */
import { BACKEND, LIMITS, isBackendConfigured } from './config.js';
import { getFirebaseIdToken } from './auth.js';
import { isModelAvailable } from './models.js';
import { buildConversationHistory, isSendableHistory } from './history.js';

const MAX_RESPONSE_BYTES = 64 * 1024;

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

async function readResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Invalid backend response.');

  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Backend response exceeded the allowed size.');
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
}, { getToken = getFirebaseIdToken, fetchRequest = fetch } = {}) {
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

  const response = await fetchRequest(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: bodyJson,
    signal
  });

  const raw = await readResponse(response);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('The backend returned an invalid response.');
  }

  if (!response.ok) {
    const quota = data?.quotaExhausted === true || (response.status === 429 && typeof data?.error === 'string' && data.error.includes('quota'));
    const message = quota
      ? QUOTA_EXHAUSTED_MESSAGE
      : response.status === 401 ? 'Your session has expired. Please sign in again.'
        : response.status === 429 ? 'Too many requests. Please wait a moment and try again.'
          : 'The AI service couldn’t respond. Please try again.';
    throw new Error(message);
  }

  if (typeof data.reply !== 'string' || !data.reply.trim()) {
    throw new Error('The backend returned an empty response.');
  }

  yield data.reply;
  return { attachmentResults: Array.isArray(data.attachmentResults) ? data.attachmentResults : undefined };
}
