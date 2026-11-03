/** Sidebar: drawer on phones (scrim, Escape, swipe-left, back button), fixed column on wide screens. */
import { escapeHtml } from './util.js';
import { groupByDate } from './store.js';
import { $, icon, toast, confirmDialog } from './ui.js';

export function initSidebar({ store, chat, router, storage }) {
  const el = $('sidebar');
  const scrim = $('scrim');
  const menuBtn = $('menu-btn');
  const list = $('conv-list');
  const search = $('sidebar-search');
  const app = $('app');
  const toggle = $('sidebar-toggle');
  const wide = matchMedia('(min-width: 700px)');
  let isOpen = false;

  // Wide screens: expanded (300px) or collapsed to an icon rail (68px). Remembered; first run depends on width.
  const saved = storage?.get('sidebar');
  let collapsed = saved ? saved === 'collapsed' : window.innerWidth < 1100;
  function applyCollapsed() {
    app.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  }
  toggle.addEventListener('click', () => { collapsed = !collapsed; storage?.set('sidebar', collapsed ? 'collapsed' : 'expanded'); applyCollapsed(); });
  $('sidebar-search-btn').addEventListener('click', () => { collapsed = false; storage?.set('sidebar', 'expanded'); applyCollapsed(); search.focus(); });
  applyCollapsed();

  const syncInert = () => { el.inert = !wide.matches && !isOpen; };

  function open() {
    if (wide.matches || isOpen) return;
    isOpen = true;
    syncInert();
    el.classList.add('is-open');
    scrim.classList.add('is-open');
    menuBtn.setAttribute('aria-expanded', 'true');
    $('sidebar-close').focus();
  }

  function close({ restoreFocus = true } = {}) {
    if (!isOpen) return;
    isOpen = false;
    el.classList.remove('is-open');
    scrim.classList.remove('is-open');
    menuBtn.setAttribute('aria-expanded', 'false');
    syncInert();
    if (restoreFocus && router.current === 'chat') menuBtn.focus();
  }

  function itemHtml(c) {
    const active = c.id === chat.activeId;
    const title = escapeHtml(c.title);
    return `<li class="conv-item${active ? ' is-active' : ''}"><button type="button" class="conv-open" data-open="${escapeHtml(c.id)}"${active ? ' aria-current="true"' : ''}>${title}</button>`
      + `<button type="button" class="conv-del" data-del="${escapeHtml(c.id)}" aria-label="Delete conversation: ${title}">${icon('trash')}</button></li>`;
  }

  function render() {
    const q = search.value.trim();
    const items = q ? store.search(q) : store.list();
    if (!items.length) {
      list.innerHTML = `<p class="conv-empty">${q ? `No conversations match “${escapeHtml(q)}”.` : 'No conversations yet. Start a new chat and it will appear here.'}</p>`;
      return;
    }
    const groups = q ? [{ label: `${items.length} ${items.length === 1 ? 'result' : 'results'}`, items }] : groupByDate(items);
    list.innerHTML = groups.map((g) =>
      `<section class="conv-group"><h2 class="conv-group-label">${escapeHtml(g.label)}</h2><ul>${g.items.map(itemHtml).join('')}</ul></section>`).join('');
  }

  list.addEventListener('click', async (e) => {
    const openBtn = e.target.closest('[data-open]');
    const delBtn = e.target.closest('[data-del]');
    if (openBtn) {
      chat.open(openBtn.dataset.open);
      router.go('chat');
      close({ restoreFocus: false });
    } else if (delBtn) {
      const conv = store.get(delBtn.dataset.del);
      if (!conv) return;
      const ok = await confirmDialog({ title: 'Delete conversation?', message: `“${conv.title}” will be removed from this device.`, confirmLabel: 'Delete' });
      if (!ok) return;
      if (chat.activeId === conv.id) chat.newChat();
      store.remove(conv.id);
      toast('Conversation deleted');
    }
  });

  const startNewChat = () => { chat.newChat(); router.go('chat'); close({ restoreFocus: false }); };
  $('sidebar-new').addEventListener('click', startNewChat);
  $('new-chat-btn').addEventListener('click', startNewChat);
  $('sidebar-settings').addEventListener('click', () => { router.go('settings'); close({ restoreFocus: false }); });
  $('sidebar-profile').addEventListener('click', () => { router.go('account'); close({ restoreFocus: false }); });
  $('sidebar-close').addEventListener('click', () => close());
  menuBtn.addEventListener('click', open);
  scrim.addEventListener('click', () => close());
  search.addEventListener('input', render);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen && !document.querySelector('dialog[open]')) close();
  });

  let startX = null;
  let startY = null;
  el.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; startY = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (startX === null) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    startX = null;
    if (isOpen && dx < -60 && Math.abs(dx) > Math.abs(dy) * 1.5) close();
  }, { passive: true });

  wide.addEventListener('change', () => { if (wide.matches) close({ restoreFocus: false }); syncInert(); });
  store.subscribe(render);
  chat.subscribe(render);
  syncInert();
  render();

  return { open, close, isOpen: () => isOpen, refresh: render, get collapsed() { return collapsed; } };
}
