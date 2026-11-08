/** Conversation store. Frontend-only persistence (localStorage); Stage 3 can sync this model to Supabase. */
import { uid } from './util.js';
import { LIMITS } from './config.js';

const KEY = 'conversations';
const ROLES = ['user', 'assistant', 'system'];
export const DEFAULT_TITLE = 'New chat';

export function sanitize(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c.id === 'string' && Array.isArray(c.messages))
    .map((c) => ({
      id: c.id,
      title: String(c.title || DEFAULT_TITLE).slice(0, 80),
      pinned: c.pinned === true,
      titleEdited: c.titleEdited === true,
      model: typeof c.model === 'string' ? c.model : 'free',
      createdAt: Number(c.createdAt) || Date.now(),
      updatedAt: Number(c.updatedAt) || Date.now(),
      messages: c.messages.filter((m) => m && typeof m.id === 'string' && typeof m.content === 'string' && ROLES.includes(m.role)),
    }));
}

export function titleFrom(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (!t) return DEFAULT_TITLE;
  return t.length > 48 ? `${t.slice(0, 47).trimEnd()}…` : t;
}

export function groupByDate(convs, now = Date.now()) {
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const day = 86_400_000;
  const buckets = [['Today', []], ['Yesterday', []], ['Previous 7 days', []], ['Older', []]];
  for (const c of convs) {
    const t = c.updatedAt;
    buckets[t >= today ? 0 : t >= today - day ? 1 : t >= today - 7 * day ? 2 : 3][1].push(c);
  }
  return buckets.filter(([, items]) => items.length).map(([label, items]) => ({ label, items }));
}

export function createStore(storage) {
  let convs = sanitize(storage.get(KEY, []));
  const subs = new Set();
  const save = () => {
    const ok = storage.set(KEY, convs);
    subs.forEach((fn) => fn());
    return ok;
  };
  const find = (id) => convs.find((c) => c.id === id) ?? null;

  return {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    list() { return [...convs].sort((a, b) => b.updatedAt - a.updatedAt); },
    get: find,
    count: () => convs.length,
    search(query) {
      const q = String(query).trim().toLowerCase();
      if (!q) return this.list();
      return this.list().filter((c) => c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)));
    },
    create(model = 'free') {
      const now = Date.now();
      const conv = { id: uid(), title: DEFAULT_TITLE, pinned: false, titleEdited: false, model, createdAt: now, updatedAt: now, messages: [] };
      convs.unshift(conv);
      if (convs.length > LIMITS.maxConversations) convs = this.list().slice(0, LIMITS.maxConversations);
      save();
      return conv;
    },
    addMessage(convId, { role, content, attachments = [], kind = null }) {
      const conv = find(convId);
      if (!conv || !ROLES.includes(role)) return null;
      const msg = { id: uid(), role, content: String(content ?? ''), ts: Date.now() };
      if (attachments.length) msg.attachments = attachments.map(({ name, size, type }) => ({ name, size, type }));
      if (kind) msg.kind = kind;
      conv.messages.push(msg);
      if (conv.messages.length > LIMITS.maxMessagesPerConversation) conv.messages.splice(0, conv.messages.length - LIMITS.maxMessagesPerConversation);
      if (role === 'user' && !conv.titleEdited && conv.title === DEFAULT_TITLE) conv.title = titleFrom(msg.content || attachments[0]?.name || '');
      conv.updatedAt = msg.ts;
      save();
      return msg;
    },
    updateMessage(convId, msgId, patch) {
      const msg = find(convId)?.messages.find((m) => m.id === msgId);
      if (!msg) return null;
      Object.assign(msg, patch);
      save();
      return msg;
    },
    removeMessage(convId, msgId) {
      const conv = find(convId);
      if (!conv) return;
      conv.messages = conv.messages.filter((m) => m.id !== msgId);
      save();
    },
    rename(id, title) {
      const conv = find(id);
      if (conv && String(title).trim()) { conv.title = String(title).trim().slice(0, 80); conv.titleEdited = true; save(); }
    },
    setPinned(id, pinned) {
      const conv = find(id);
      if (conv) { conv.pinned = Boolean(pinned); save(); }
    },
    remove(id) {
      const before = convs.length;
      convs = convs.filter((c) => c.id !== id);
      if (convs.length !== before) save();
    },
    clear() { convs = []; storage.remove(KEY); subs.forEach((fn) => fn()); },
  };
}
