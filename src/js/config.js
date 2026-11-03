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
export const BACKEND = { baseUrl: null };

/** Stage 3+: Supabase project URL and *anon* key (public). Never the service-role key. */
export const SUPABASE = { url: null, anonKey: null };

export const LIMITS = Object.freeze({
  maxMessageLength: 8000,
  maxAttachments: 5,
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxConversations: 100,
  maxMessagesPerConversation: 500,
});

export const isBackendConfigured = () => Boolean(BACKEND.baseUrl);
