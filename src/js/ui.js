/** Shared UI helpers: toast, dialogs, clipboard, icons and accessible radio groups. */
export const $ = (id) => document.getElementById(id);

export const icon = (name, cls = 'i') =>
  `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;

let toastTimer = 0;
export function toast(message, duration = 2600) {
  const el = $('toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.textContent = message;
  el.classList.add('is-visible');
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), duration);
}

export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall back below */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Resolves true when the user confirms, false for cancel / Escape / back. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = true }) {
  const dlg = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-msg').textContent = message;
  const ok = $('confirm-ok');
  ok.textContent = confirmLabel;
  ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  dlg.returnValue = '';
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
  });
}

/** Closes the top-most open dialog (used by the Android back button). Returns true if one was closed. */
export function closeTopDialog() {
  const open = document.querySelector('dialog[open]');
  if (!open) return false;
  open.close();
  return true;
}

/** Tap outside a bottom sheet to dismiss it. */
export function enableLightDismiss(dlg) {
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}

/** Roving-tabindex radio group with arrow-key support. Items: [role="radio"][data-value]. */
export function radioGroup(root, onChange) {
  const items = () => [...root.querySelectorAll('[role="radio"]')];
  const set = (value) => {
    let any = false;
    items().forEach((b) => {
      const on = b.dataset.value === value;
      any = any || on;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    if (!any && items()[0]) items()[0].tabIndex = 0;
  };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[role="radio"]');
    if (!b || !root.contains(b)) return;
    set(b.dataset.value);
    onChange?.(b.dataset.value);
  });
  root.addEventListener('keydown', (e) => {
    const list = items();
    const idx = list.indexOf(document.activeElement);
    if (idx < 0) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    let next = idx;
    if (step) next = (idx + step + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else return;
    e.preventDefault();
    list[next].focus();
    list[next].click();
  });
  return { set };
}
