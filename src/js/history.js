/**
 * Conversation context for chat requests.
 *
 * The Cloudflare Worker is stateless: the model only knows what the current request contains,
 * so every request must carry the earlier turns of *this* conversation. Stored conversations also
 * hold things that must never reach the model — local error notices, empty assistant placeholders
 * written while a reply is still arriving, and attachment-only messages with no text — so this
 * module turns stored messages into the clean `[{ role, content }]` list that is sent.
 *
 * Attachment-aware: when a stored user turn carries extracted content (an image analysis or a
 * document's text, persisted on-device at send time), it is folded into that turn's content so
 * follow-up questions keep working without re-uploading the file. Only extracted content is
 * folded in — attachment metadata (names alone) never becomes model context.
 *
 * Rules (covered by tests/unit/context.test.js and tests/unit/attachment-context.test.js):
 *  - only `user` and `assistant` turns are sent (never local notices, never another chat);
 *  - blank turns are dropped, because an empty message invalidates the whole request;
 *  - a turn with only extracted attachment context and no text is still sent;
 *  - the newest turn is always included, kept last and included exactly once;
 *  - history never starts with an assistant reply (a truncated turn confuses the model);
 *  - size is bounded by message count, per-message length and total characters.
 */
import { LIMITS } from './config.js';

export const HISTORY_LIMITS = Object.freeze({
  maxMessages: LIMITS.maxHistoryMessages,
  maxMessageChars: LIMITS.maxHistoryMessageChars,
  maxTotalChars: LIMITS.maxHistoryTotalChars,
});

const isChatRole = (role) => role === 'user' || role === 'assistant';

// Bounds for the attachment context folded into history turns. The current message always
// reaches the model with its full payload via the attachments field; these blocks exist so
// follow-up turns keep the extracted content available with the Worker being stateless.
const MAX_IMAGE_BLOCK_CHARS = 700;
const MAX_DOCUMENT_BLOCK_CHARS = 1500;

/**
 * Builds the bounded `[Attached …]` context block for a stored message, or an empty string.
 * Only extracted content (image analyses, document text) is folded in — never filenames alone.
 */
export function attachmentContextBlock(message, { imageChars = MAX_IMAGE_BLOCK_CHARS, documentChars = MAX_DOCUMENT_BLOCK_CHARS } = {}) {
  if (!message || typeof message !== 'object' || !Array.isArray(message.attachments)) return '';
  const blocks = [];
  for (const attachment of message.attachments) {
    if (!attachment || typeof attachment !== 'object') continue;
    const name = String(attachment.name ?? 'file').slice(0, 120);
    const analysis = typeof attachment.analysis === 'string' ? attachment.analysis.trim() : '';
    const extracted = typeof attachment.extractedText === 'string' ? attachment.extractedText.trim() : '';
    if (analysis) blocks.push(`[Attached image "${name}": ${analysis.slice(0, imageChars)}]`);
    else if (extracted) blocks.push(`[Attached document "${name}": ${extracted.slice(0, documentChars)}]`);
  }
  return blocks.join('\n');
}

/** Returns a clean `{ role, content }` copy of a stored message, or null when it carries no context. */
export function toChatMessage(message, { maxMessageChars = HISTORY_LIMITS.maxMessageChars } = {}) {
  if (!message || typeof message !== 'object' || !isChatRole(message.role)) return null;
  const raw = typeof message.content === 'string' ? message.content : '';
  const text = raw.trim();
  const block = attachmentContextBlock(message);
  if (!text && !block) return null;

  const parts = [];
  if (text) parts.push(text);
  if (block) parts.push(block);
  let content = parts.join('\n');
  if (content.length > maxMessageChars) {
    // The user's own words lose characters before the extracted attachment context does.
    const blockRoom = block ? Math.min(block.length, Math.floor(maxMessageChars * 0.7)) : 0;
    const headRoom = Math.max(0, maxMessageChars - (blockRoom ? blockRoom + 1 : 0));
    content = block
      ? [text.slice(0, headRoom), block.slice(0, blockRoom)].filter(Boolean).join('\n')
      : text.slice(0, maxMessageChars);
  }
  if (!content.trim()) return null;
  return { role: message.role, content };
}

/**
 * Builds the message list for one request from the messages of the open conversation.
 * `excludeId` skips the empty assistant placeholder that is created while a reply is arriving.
 */
export function buildConversationHistory(messages, {
  excludeId = null,
  maxMessages = HISTORY_LIMITS.maxMessages,
  maxMessageChars = HISTORY_LIMITS.maxMessageChars,
  maxTotalChars = HISTORY_LIMITS.maxTotalChars,
} = {}) {
  const source = Array.isArray(messages) ? messages : [];
  const newestFirst = [];
  let totalChars = 0;

  for (let i = source.length - 1; i >= 0; i--) {
    const raw = source[i];
    if (excludeId && raw && raw.id === excludeId) continue;
    const message = toChatMessage(raw, { maxMessageChars });
    if (!message) continue;

    // An immediately repeated identical turn is the same turn: keep the newest copy only.
    const previous = newestFirst[newestFirst.length - 1];
    if (previous && previous.role === message.role && previous.content === message.content) continue;

    if (newestFirst.length >= maxMessages) break;
    const room = maxTotalChars - totalChars;
    if (room <= 0) break;

    if (message.content.length > room) {
      // Older turns are dropped whole; only the newest turn is cut to fit, so it is never lost.
      if (newestFirst.length > 0) break;
      const content = message.content.slice(0, room);
      if (!content.trim()) break;
      newestFirst.push({ role: message.role, content });
      break;
    }

    newestFirst.push({ role: message.role, content: message.content });
    totalChars += message.content.length;
  }

  const history = newestFirst.reverse();

  // Drop a leading assistant reply so the model always receives complete turns.
  while (history.length && history[0].role !== 'user') history.shift();

  return history;
}

/** True when the list can be sent as-is: non-empty and ending with a user turn. */
export const isSendableHistory = (history) => Array.isArray(history) &&
  history.length > 0 && history[history.length - 1]?.role === 'user';
