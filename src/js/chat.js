/** Chat rendering, composer, transport and client-side response reveal. */
import { renderMarkdown } from './markdown.js';
import { escapeHtml, formatBytes, plural, uid } from './util.js';
import { LIMITS } from './config.js';
import { buildConversationHistory } from './history.js';
import { revealText } from './reveal.js';
import { isModelAvailable } from './models.js';
import { $, icon, toast, copyText } from './ui.js';
import {
  validateFile, typeLabel, downscaleImageFile, extractDocumentText,
  processPdfDocument, buildSendAttachments, mergeAnalyses,
} from './attachments.js';

export function messageHtml(msg) {
  if (msg.role === 'system') {
    return `<li class="msg msg-system" data-id="${escapeHtml(msg.id)}"><div class="notice">${icon('alert')}<div class="md">${renderMarkdown(msg.content)}</div></div></li>`;
  }
  const files = msg.attachments?.length ? renderMessageAttachments(msg.attachments) : '';
  const body = msg.role === 'user'
    ? `<div class="msg-text">${escapeHtml(msg.content)}</div>${files}`
    : `<div class="msg-body md">${msg.content ? renderMarkdown(msg.content) : '<span class="typing" aria-label="NYX AI is responding"><i></i><i></i><i></i></span>'}</div>`;
  const avatar = msg.role === 'assistant' ? '<img class="msg-avatar" src="src/assets/logo/nyx-mark-512-transparent.png" alt="" width="30" height="30">' : '';
  return `<li class="msg msg-${msg.role}" data-id="${escapeHtml(msg.id)}">${avatar}<div class="msg-main"><div class="msg-bubble">${body}</div>`
    + `<div class="msg-actions"><button type="button" class="act" data-copy-msg aria-label="Copy message">${icon('copy')}</button></div></div></li>`;
}

/** Rich attachment cards inside a sent message bubble (no remove controls, display only). */
function renderMessageAttachments(attachments) {
  const items = attachments.map((f) => {
    const label = typeLabel(f);
    const kind = String(f.kind ?? (String(f.type).startsWith('image/') ? 'image' : 'document'));
    const bits = [formatBytes(f.size), label];
    if (f.pageCount) bits.push(`${f.pageCount} page${f.pageCount === 1 ? '' : 's'}`);
    if (f.scanned && f.ocrPages) bits.push(`OCR · ${f.ocrPages} page${f.ocrPages === 1 ? '' : 's'} read`);
    else if (f.truncated) bits.push('text truncated');
    if (f.analysis || f.extractedText) bits.push('analysed');
    const sub = escapeHtml(bits.filter(Boolean).join(' · '));
    if (kind === 'image') {
      const media = f.thumb
        ? `<img class="msg-attach-thumb" src="${escapeHtml(f.thumb)}" alt="" width="96" height="96">`
        : `<span class="msg-attach-icon">${icon('image')}</span>`;
      return `<li class="msg-file msg-file-image">${media}<span class="msg-file-meta"><span class="msg-file-name">${escapeHtml(f.name)}</span><span class="msg-file-sub">${sub}</span></span></li>`;
    }
    return `<li class="msg-file"><span class="msg-attach-icon">${icon('file')}</span><span class="msg-file-meta"><span class="msg-file-name">${escapeHtml(f.name)}</span><span class="msg-file-sub">${sub}</span></span></li>`;
  }).join('');
  return `<ul class="msg-files" aria-label="Attachments">${items}</ul>`;
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
  const processing = () => attachments.some((a) => a.status === 'processing');

  function updateSend() {
    els.send.disabled = processing() || (!els.input.value.trim() && attachments.length === 0);
    els.send.hidden = generating();
    els.stop.hidden = !generating();
  }

  function attachmentChip(a, n) {
    const label = escapeHtml(typeLabel(a));
    const media = a.kind === 'image'
      ? (a.previewUrl ? `<img class="attachment-thumb" src="${escapeHtml(a.previewUrl)}" alt="">` : `<span class="attachment-doc">${icon('image')}</span>`)
      : `<span class="attachment-doc">${icon('file')}</span>`;
    let status;
    if (a.status === 'processing') {
      status = `<span class="attachment-status" role="status"><span class="attachment-spinner" aria-hidden="true"></span>${escapeHtml(a.processingLabel ?? 'Reading…')}</span>`;
    } else if (a.status === 'error') {
      status = `<span class="attachment-status is-error">${icon('alert')}${escapeHtml(a.error ?? 'Couldn’t process this file.')}</span>`;
    } else if (a.kind === 'document' && a.scanned) {
      status = `<span class="attachment-status is-ok">${icon('check')}Scanned PDF · ${a.ocrImages?.length ?? 0} of ${a.pageCount ?? '?'} pages for OCR</span>`;
    } else if (a.kind === 'document') {
      const pages = a.pageCount ? ` · ${a.pageCount} page${a.pageCount === 1 ? '' : 's'}` : '';
      status = `<span class="attachment-status is-ok">${icon('check')}Text extracted${pages}${a.truncated ? ' · truncated' : ''}</span>`;
    } else {
      status = `<span class="attachment-status is-ok">${icon('check')}Ready to analyse</span>`;
    }
    const retry = a.status === 'error'
      ? `<button type="button" class="attachment-retry" data-retry-file="${n}" aria-label="Retry ${escapeHtml(a.name)}">${icon('refresh')}</button>`
      : '';
    return `<span class="attachment${a.status === 'error' ? ' is-error' : ''}">${media}`
      + `<span class="attachment-meta"><span class="name">${escapeHtml(a.name)}</span>`
      + `<span class="size">${formatBytes(a.size)} · ${label}</span>${status}</span>${retry}`
      + `<button type="button" class="attachment-remove" data-remove-file="${n}" aria-label="Remove ${escapeHtml(a.name)}">${icon('close')}</button></span>`;
  }

  function renderAttachments() {
    els.chips.hidden = attachments.length === 0;
    els.chips.innerHTML = attachments.map(attachmentChip).join('');
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
    discardAttachments();
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

  async function processAttachment(entry) {
    try {
      if (entry.kind === 'image') {
        entry.processingLabel = 'Compressing…';
        renderAttachments();
        const result = await downscaleImageFile(entry.file);
        Object.assign(entry, {
          status: 'ready', data: result.data, mime: result.mime, thumb: result.thumb,
          previewUrl: URL.createObjectURL(entry.file),
        });
      } else {
        const isPdf = /\.pdf$/i.test(entry.name) || entry.mime === 'application/pdf';
        if (isPdf) {
          entry.processingLabel = 'Reading PDF…';
          renderAttachments();
          const result = await processPdfDocument(entry.file);
          if (result.likelyScanned) {
            if (result.ocrUnavailable) throw new Error('This PDF has no text layer and pages can’t be rendered here.');
            if (!result.ocrImages?.length) throw new Error('This scanned PDF has no readable pages.');
            Object.assign(entry, {
              status: 'ready', scanned: true, text: '', pageCount: result.pageCount,
              ocrImages: result.ocrImages, truncated: false,
            });
          } else {
            Object.assign(entry, { status: 'ready', text: result.text, truncated: result.truncated, pageCount: result.pageCount, scanned: false });
          }
        } else {
          entry.processingLabel = 'Extracting text…';
          renderAttachments();
          const result = await extractDocumentText(entry.file);
          if (!result.text) throw new Error('No readable text could be extracted from this file.');
          Object.assign(entry, { status: 'ready', text: result.text, truncated: result.truncated, pageCount: result.pageCount ?? null, scanned: false });
        }
      }
    } catch (err) {
      console.error('[NYX] attachment processing failed', err?.message ?? err);
      entry.status = 'error';
      entry.error = err instanceof Error && err.message ? err.message : 'That file couldn’t be processed.';
    }
    renderAttachments();
  }

  function addFiles(fileList) {
    const files = [...fileList];
    let rejected = 0;
    for (const file of files) {
      if (attachments.length >= LIMITS.maxAttachments) { toast(`You can attach up to ${plural(LIMITS.maxAttachments, 'file')}.`); break; }
      const verdict = validateFile(file);
      if (!verdict.ok) { rejected += 1; if (rejected <= 2) toast(verdict.error); continue; }
      const entry = {
        id: uid(), file, name: file.name, size: file.size, type: verdict.mime, kind: verdict.kind,
        status: 'processing', processingLabel: verdict.kind === 'image' ? 'Compressing…' : 'Extracting text…',
      };
      attachments.push(entry);
      processAttachment(entry);
    }
    if (rejected > 2) toast(`${plural(rejected, 'file')} skipped.`);
    renderAttachments();
  }

  function retryAttachment(index) {
    const entry = attachments[index];
    if (!entry || entry.status !== 'error') return;
    entry.status = 'processing';
    entry.error = null;
    entry.processingLabel = entry.kind === 'image' ? 'Compressing…' : 'Extracting text…';
    renderAttachments();
    processAttachment(entry);
  }

  function discardAttachments() {
    for (const entry of attachments) if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    attachments = [];
  }

  async function runTransport(conv, { wireAttachments, wireMap, composerEntries } = {}) {
    const controller = new AbortController();
    abort = controller;
    updateSend();
    const reply = store.addMessage(conv.id, { role: 'assistant', content: '' });
    append(reply);
    let text = '';
    let failure = null;
    let attachmentResults = null;
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
      // Manual iteration so the generator's return value (the per-image analyses, when the real
      // transport provides them) can be persisted for follow-up context.
      const generator = transport({ conversationId: conv.id, messages: history, model: getModelId(), signal: controller.signal, attachments: wireAttachments });
      let step = await generator.next();
      while (!step.done) {
        const chunk = step.value;
        await revealText(String(chunk), { signal: controller.signal, onText: (part) => { text += part; paint(); } });
        step = await generator.next();
      }
      attachmentResults = step.done && step.value && typeof step.value === 'object' ? step.value.attachmentResults ?? null : null;
    } catch (err) {
      if (err?.name !== 'AbortError') {
        failure = err?.message === 'Your session has expired. Please sign in again.'
          || err?.message === 'Too many requests. Please wait a moment and try again.'
          || err?.message === 'The free daily AI quota is exhausted. It resets at 00:00 UTC.'
          ? err.message : 'The reply couldn’t be completed. Check your connection and try again.';
      }
    } finally {
      if (abort === controller) abort = null;
      if (attachmentResults && wireMap?.length && composerEntries?.userMessageId && Array.isArray(composerEntries?.entries)) {
        const userMessageId = composerEntries.userMessageId;
        if (userMessageId) {
          const merged = mergeAnalyses(composerEntries.entries, wireMap, attachmentResults)
            .map(({ name, size, type, kind, thumb, pageCount, truncated, scanned, ocrImages, ocrPagesRead, analysis, extractedText }) => ({
              name, size, type, kind, thumb, pageCount, truncated, scanned,
              ocrPages: ocrPagesRead ?? ocrImages?.length,
              analysis, extractedText,
            }));
          store.updateMessage(conv.id, userMessageId, { attachments: merged });
        }
      }
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
      if (processing()) { toast('Still processing your files…'); return; }

      // Files that failed validation/processing are never sent silently — the user retries or removes them.
      const ready = attachments.filter((a) => a.status === 'ready');
      const failedCount = attachments.length - ready.length;
      if (failedCount) {
        toast(`${plural(failedCount, 'file')} couldn’t be processed — retry or remove ${failedCount === 1 ? 'it' : 'them'} to send.`);
        return;
      }

      // Build the wire payload before touching the conversation, so an over-budget request
      // never creates a half-sent message.
      const built = ready.length ? buildSendAttachments(ready) : { attachments: [], map: [] };
      if (built.error) { toast(built.error); return; }

      conv = activeId ? store.get(activeId) : null;
      if (!conv) { conv = store.create(getModelId()); setActive(conv.id); }

      // Metadata persisted with the message (never the originals). Analyses are merged in
      // after the reply arrives, so follow-up turns keep the extracted context.
      const persisted = ready.map(({ name, size, type, kind, thumb, pageCount, truncated, scanned, ocrImages, text, extractedText }) => ({
        name, size, type, kind, thumb, pageCount, truncated, scanned,
        ocrPages: ocrImages?.length,
        // Persist the extracted text (bounded on storage) so follow-up turns keep the context;
        // scanned PDFs get theirs merged in from the OCR results after the reply arrives.
        extractedText: extractedText ?? (kind === 'document' && !scanned ? text : undefined),
      }));
      const userMessage = store.addMessage(conv.id, { role: 'user', content: text, attachments: persisted });
      if (!userMessage) throw new Error('The conversation is no longer available.');
      append(userMessage);
      const filesToSend = ready;
      const entriesSnapshot = ready.map((entry) => ({ ...entry }));
      discardAttachments();
      els.input.value = '';
      renderAttachments();
      autosize();

      // A message without text has nothing to ask of the model; attachments travel only with text.
      if (!text) {
        append(store.addMessage(conv.id, { role: 'system', kind: 'attachment-only', content: '**Attachments need a message to go with them.** Tell NYX AI what you need — for example “Summarise this PDF” or “What’s in this image?”' }));
        return;
      }

      if (!transport) {
        append(store.addMessage(conv.id, { role: 'system', kind: 'backend-offline', content: 'Chat is temporarily unavailable. Please try again later.' }));
        return;
      }

      await runTransport(conv, {
        wireAttachments: built.attachments.length ? built.attachments : undefined,
        wireMap: built.map,
        composerEntries: { userMessageId: userMessage.id, entries: entriesSnapshot },
      });
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
    const remove = e.target.closest('[data-remove-file]');
    if (remove) {
      const index = Number(remove.dataset.removeFile);
      const [entry] = attachments.splice(index, 1);
      if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      renderAttachments();
      return;
    }
    const retry = e.target.closest('[data-retry-file]');
    if (retry) retryAttachment(Number(retry.dataset.retryFile));
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
