/**
 * NYX AI — central configuration.
 *
 * SECURITY: never put secrets in this file or anywhere in the app bundle.
 * Provider/API keys belong in Cloudflare Worker secrets (server side only).
 * Only public, non-secret values (a Worker URL, a Supabase *anon* key) may be added here in a later stage.
 */
export const APP = Object.freeze({
  name: 'NYX AI',
  tagline: 'Intelligence beyond limits.',
  version: '0.2.1',
  stage: 'Stage 2 — Android frontend',
  repo: 'https://github.com/0-umbra/NYX-AI',
});

/** Stage 3: set to the Cloudflare Worker URL, e.g. 'https://nyx-api.example.workers.dev'. */
export const BACKEND = {
  baseUrl: 'https://nyx-ai-backend.mehrablone100-8ee.workers.dev'
};

/** Stage 3+: Supabase project URL and *anon* key (public). Never the service-role key. */
export const SUPABASE = { url: null, anonKey: null };

export const LIMITS = Object.freeze({
  maxMessageLength: 8000,
  maxAttachments: 5,
  maxAttachmentBytes: 10 * 1024 * 1024,
  // Images are re-encoded down to these bounds before being sent to the Worker
  // (which enforces the same caps server-side — keep the two in sync with backend/src/attachments.js).
  maxImageEdge: 1024,
  maxImageBytes: 1_400_000, // decoded bytes per image
  maxOcrPages: 3,             // scanned-PDF pages read through the vision model per document
  maxPdfPages: 200,           // pages read at most in one PDF (text extraction and scanned detection)
  maxDocumentChars: 8000,     // extracted text per document
  maxTotalDocumentChars: 12000, // extracted text across documents per message
  maxAnalysisChars: 1600,     // vision-model analysis kept per image
  maxStoredExtractedChars: 4000, // document text persisted on-device for follow-up context
  maxStoredImageThumbChars: 6000, // persisted 96px preview per image (optional)
  // Transport guard: refuse to send a request whose JSON body exceeds this size.
  maxRequestBytes: 6 * 1024 * 1024,
  maxConversations: 100,
  maxMessagesPerConversation: 500,
  // Conversation context sent with each request. Must stay inside the Worker limits
  // (24 messages, 4000 characters per message, 24000 characters in total).
  maxHistoryMessages: 16,
  maxHistoryMessageChars: 4000,
  maxHistoryTotalChars: 12000,
});

export const isBackendConfigured = () => Boolean(BACKEND.baseUrl);
