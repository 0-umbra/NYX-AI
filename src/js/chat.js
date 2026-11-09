/** Chat rendering, composer, transport and client-side response reveal. */
import { renderMarkdown } from './markdown.js';
import { escapeHtml, formatBytes, plural } from './util.js';
import { LIMITS } from './config.js';
import { buildConversationHistory } from './history.js';
import { revealText } from './reveal.js';
import { isModelAvailable } from './models.js';
import { $, icon, toast, copyText } from './ui.js';

export function messageHtml(msg) {
  if (msg.role === 'system') {
    return `<li class="msg msg-system" data-id="${escapeHtml(msg.id)}"><div class="notice">${icon('alert')}<div class="md">${renderMarkdown(msg.content)}</div></div></li>`;
  }
  const files = msg.attachments?.length
    ? `<ul class="msg-files" aria-label="Attachments">${msg.attachments.map((f) => `<li class="file-pill">${icon(String(f.type).startsWith('image/') ? 'image' : 'file')}<span>${escapeHtml(f.name)}</span></li>`).join('')}</ul>`
    : '';
  const body = msg.role === 'user'
    ? `<div class="msg-text">${escapeHtml(msg.content)}</div>${files}`
    : `<div class="msg-body md">${msg.content ? renderMarkdown(msg.content) : '<span class="typing" aria-label="NYX AI is responding"><i></i><i></i><i></i></span>'}</div>`;
  const avatar = msg.role === 'assistant' ? '<img class="msg-avatar" src="src/assets/logo/nyx-mark-512.png" alt="" width="30" height="30">' : '';
  return `<li class="msg msg-${msg.role}" data-id="${escapeHtml(msg.id)}">${avatar}<div class="msg-main"><div class="msg-bubble">${body}</div>`
    + `<div class="msg-actions"><button type="button" class="act" data-copy-msg aria-label="Copy message">${icon('copy')}</button></div></div></li>`;
}

const ACTIVE_KEY = 'activeConversation';

export function initChat({ store, getModelId, storage = null }) {
  const els = {
    scroller: $('messages'), list: $('message-list'), welcome: $('welcome'), form: $('composer'), input: $('composer-input'),
    send: $('send-btn'), stop: $('stop-btn'), attach: $('attach-btn'), image: $('image-btn'), voice: $('voice-btn'), file: $('file-input'), imageFile: $('image-input'),
    chips: $('attachments'), jump: $('jump-btn'),
  };
  const subs = new Set();
  let activeId = null;
  let transport = null;
  let abort = null;
  let attachments = [];

  // Restore the conversation that was open before a reload or an Android WebView restart.
  // Without this the next message would silently start a brand-new chat with no context.
  const remember = (id) => {
    if (!storage) return;
    if (id) storage.set(ACTIVE_KEY, id);
    else storage.remove(ACTIVE_KEY);
  };
  const restored = storage?.get(ACTIVE_KEY, null);
  if (typeof restored === 'string' && store.get(restored)) activeId = restored;
  else if (restored) remember(null);

  const generating = () => abort !== null;
  const pinned = () => els.scroller.scrollHeight - els.scroller.scrollTop - els.scroller.clientHeight < 90;
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'reduce';
  let smoothUntil = 0;
  const scrollToBottom = (smooth = false) => {
    const animate = smooth && !reducedMotion();
    if (animate) smoothUntil = Date.now() + 500;
    els.scroller.scrollTo({ top: els.scroller.scrollHeight, behavior: animate ? 'smooth' : 'auto' });
    els.jump.hidden = true;
  };
  const updateJump = () => { if (Date.now() < smoothUntil) return; els.jump.hidden = pinned() || !els.list.children.length; };

  function autosize() {
    els.input.style.height = 'auto';
    const cap = parseInt(getComputedStyle(els.input).maxHeight, 10) || 150;
    els.input.style.height = `${Math.min(els.input.scrollHeight, cap)}px`;
  }
  function updateSend() {
    els.send.disabled = !els.input.value.trim() && attachments.length === 0;
    els.send.hidden = generating();
    els.stop.hidden = !generating();
  }

  function renderAttachments() {
    els.chips.hidden = attachments.length === 0;
    els.chips.innerHTML = attachments.map((a, n) =>
      `<span class="attachment">${icon(String(a.type).startsWith('image/') ? 'image' : 'file')}<span class="name">${escapeHtml(a.name)}</span><span class="size">${formatBytes(a.size)}</span>`
      + `<button type="button" data-remove-file="${n}" aria-label="Remove ${escapeHtml(a.name)}">${icon('close')}</button></span>`).join('');
    updateSend();
  }

  function render() {
    const conv = activeId ? store.get(activeId) : null;
    const msgs = conv?.messages ?? [];
    els.list.innerHTML = msgs.map(messageHtml).join('');
    els.welcome.hidden = msgs.length > 0;
    if (msgs.length) scrollToBottom();
    else { els.scroller.scrollTop = 0; els.jump.hidden = true; } // welcome screen always starts at the top
  }

  function append(msg) {
    const wasPinned = pinned() || Date.now() < smoothUntil;
    els.welcome.hidden = true;
    els.list.insertAdjacentHTML('beforeend', messageHtml(msg));
    if (wasPinned || msg.role === 'user') scrollToBottom(true); else updateJump();
  }

  function setActive(id) {
    activeId = id;
    remember(id);
    subs.forEach((fn) => fn(id));
  }

  function stopGenerating() {
    abort?.abort();
  }

  function newChat() {
    stopGenerating();
    setActive(null);
    attachments = [];
    els.input.value = '';
    renderAttachments();
    autosize();
    render();
  }

  function open(id) {
    if (!store.get(id)) return;
    stopGenerating();
    setActive(id);
    render();
  }

  function addFiles(fileList) {
    const files = [...fileList];
    let rejected = 0;
    for (const file of files) {
      if (attachments.length >= LIMITS.maxAttachments) { toast(`You can attach up to ${plural(LIMITS.maxAttachments, 'file')}.`); break; }
      if (file.size > LIMITS.maxAttachmentBytes) { rejected++; continue; }
      attachments.push({ file, name: file.name, size: file.size, type: file.type });
    }
    if (rejected) toast(`${plural(rejected, 'file')} over ${formatBytes(LIMITS.maxAttachmentBytes)} skipped.`);
    renderAttachments();
  }

  async function runTransport(conv) {
    const controller = new AbortController();
    abort = controller;
    updateSend();
    const reply = store.addMessage(conv.id, { role: 'assistant', content: '' });
    append(reply);
    let text = '';
    let failure = null;
    const paint = () => {
      if (activeId !== conv.id) return;
      const body = els.list.querySelector(`[data-id="${CSS.escape(reply.id)}"] .msg-body`);
      if (!body) return;
      const wasPinned = pinned();
      body.innerHTML = renderMarkdown(text);
      if (wasPinned) scrollToBottom(); else updateJump();
    };
    try {
      // Only this conversation, cleaned and bounded: earlier turns plus the newest user message.
      const history = buildConversationHistory(store.get(conv.id)?.messages ?? [], { excludeId: reply.id });
      for await (const chunk of transport({ conversationId: conv.id, messages: history, model: getModelId(), signal: controller.signal })) {
        await revealText(String(chunk), { signal: controller.signal, onText: (part) => { text += part; paint(); } });
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        failure = err?.message === 'Your session has expired. Please sign in again.' || err?.message === 'Too many requests. Please wait a moment and try again.'
          ? err.message : 'The reply couldn’t be completed. Check your connection and try again.';
      }
    } finally {
      if (abort === controller) abort = null;
      if (text) store.updateMessage(conv.id, reply.id, { content: text });
      else store.removeMessage(conv.id, reply.id);
      if (failure) store.addMessage(conv.id, { role: 'system', kind: 'error', content: failure });
      if (activeId === conv.id) {
        const wasPinned = pinned();
        const scrollTop = els.scroller.scrollTop;
        const convNow = store.get(conv.id);
        els.list.innerHTML = (convNow?.messages ?? []).map(messageHtml).join('');
        if (wasPinned) scrollToBottom(); else { els.scroller.scrollTop = scrollTop; updateJump(); }
      }
      updateSend();
    }
  }

  async function send() {
    // Everything before the transport runs outside runTransport's own try/catch, and send() is
    // called without await from the submit handler. An unexpected throw there would escape as an
    // unhandled rejection and surface as the generic "Something went wrong" toast with no context,
    // so failures are reported in the conversation instead.
    let conv = null;
    try {
      const text = els.input.value.trim();
      if (generating() || (!text && attachments.length === 0)) return;
      if (!isModelAvailable(getModelId())) { toast('This model tier is not available yet.'); return; }
      conv = activeId ? store.get(activeId) : null;
      if (!conv) { conv = store.create(getModelId()); setActive(conv.id); }
      const files = attachments;
      const userMessage = store.addMessage(conv.id, { role: 'user', content: text, attachments: files });
      if (!userMessage) throw new Error('The conversation is no longer available.');
      append(userMessage);
      attachments = [];
      els.input.value = '';
      renderAttachments();
      autosize();

      // Attachments are saved locally only, so a message without text has nothing to ask the model.
      // Sending it would put an empty turn in the conversation that the backend has to reject.
      if (!text) {
        append(store.addMessage(conv.id, { role: 'system', kind: 'attachment-only', content: '**Attachments are stored on this device only.** Add a message describing what you need from them.' }));
        return;
      }

      if (!transport) {
        append(store.addMessage(conv.id, { role: 'system', kind: 'backend-offline', content: 'Chat is temporarily unavailable. Please try again later.' }));
        return;
      }
      await runTransport(conv);
    } catch (err) {
      console.error('[NYX] message could not be sent', err);
      if (conv && store.get(conv.id)) {
        append(store.addMessage(conv.id, { role: 'system', kind: 'error', content: 'The message could not be sent. Please try again.' }));
      }
    }
  }

  // Events ----------------------------------------------------------------
  els.form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
  els.input.addEventListener('input', () => { autosize(); updateSend(); });
  els.input.addEventListener('focus', () => setTimeout(() => { if (pinned()) scrollToBottom(); }, 250));
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      els.form.requestSubmit();
    }
  });
  els.stop.addEventListener('click', stopGenerating);
  els.attach.addEventListener('click', () => els.file.click());
  els.image.addEventListener('click', () => els.imageFile.click());
  els.imageFile.addEventListener('change', () => { addFiles(els.imageFile.files); els.imageFile.value = ''; });
  els.file.addEventListener('change', () => { addFiles(els.file.files); els.file.value = ''; });
  els.chips.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-file]');
    if (!btn) return;
    attachments.splice(Number(btn.dataset.removeFile), 1);
    renderAttachments();
  });
  els.voice.addEventListener('click', () => toast('Voice input isn’t available yet.'));
  els.jump.addEventListener('click', () => scrollToBottom(true));
  els.scroller.addEventListener('scroll', updateJump, { passive: true });
  els.welcome.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-suggest]');
    if (!chip) return;
    els.input.value = chip.dataset.suggest;
    autosize(); updateSend(); els.input.focus();
  });
  els.list.addEventListener('click', async (e) => {
    const codeBtn = e.target.closest('[data-copy-code]');
    const msgBtn = e.target.closest('[data-copy-msg]');
    const btn = codeBtn || msgBtn;
    if (!btn) return;
    const text = codeBtn
      ? codeBtn.closest('.code-block').querySelector('code').textContent
      : (msgBtn.closest('.msg').querySelector('.msg-text, .msg-body')?.innerText ?? '');
    const ok = await copyText(text);
    toast(ok ? 'Copied to clipboard' : 'Couldn’t copy. Select the text and copy it manually.');
    if (ok && msgBtn) { msgBtn.classList.add('is-done'); setTimeout(() => msgBtn.classList.remove('is-done'), 1500); }
    if (ok && codeBtn) { codeBtn.textContent = 'Copied'; setTimeout(() => { codeBtn.textContent = 'Copy'; }, 1500); }
  });
  window.visualViewport?.addEventListener('resize', () => { if (pinned()) scrollToBottom(); });

  updateSend();
  render();

  return {
    newChat, open, send, scrollToBottom,
    get activeId() { return activeId; },
    get generating() { return generating(); },
    focusInput: () => els.input.focus(),
    setTransport(fn) { transport = typeof fn === 'function' ? fn : null; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}
