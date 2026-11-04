/**
 * NYX AI — Cloud Backend Transport.
 * Sends Firebase-authenticated requests to the Cloudflare Worker.
 */
import { BACKEND, isBackendConfigured } from './config.js';
import { getFirebaseIdToken } from './auth.js';

const MAX_RESPONSE_BYTES = 64 * 1024;

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

export async function* createTransport({
  conversationId,
  messages,
  model,
  signal
}) {
  if (signal?.aborted) {
    throw new DOMException('Request cancelled.', 'AbortError');
  }

  const token = await getFirebaseIdToken();
  const endpoint = getEndpoint();

  const safeMessages = messages.slice(-12).map(message => ({
    role: message.role,
    content: message.content
  }));

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      conversationId,
      model,
      messages: safeMessages
    }),
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
    throw new Error(
      typeof data.error === 'string'
        ? data.error
        : 'The backend request failed.'
    );
  }

  if (typeof data.reply !== 'string' || !data.reply.trim()) {
    throw new Error('The backend returned an empty response.');
  }

  yield data.reply;
}
