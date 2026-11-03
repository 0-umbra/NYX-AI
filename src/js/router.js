/** Hash router. Routes: #/chat (default), #/settings, #/appearance, #/account, #/memory, #/models, #/about */
export const ROUTES = Object.freeze({
  chat: { title: 'NYX AI', parent: null },
  settings: { title: 'Settings', parent: 'chat' },
  appearance: { title: 'Appearance', parent: 'settings' },
  account: { title: 'Account', parent: 'settings' },
  memory: { title: 'Memory', parent: 'settings' },
  models: { title: 'Model information', parent: 'settings' },
  about: { title: 'About NYX AI', parent: 'settings' },
});
export const DEFAULT_ROUTE = 'chat';

export function parseHash(hash) {
  const m = /^#\/?([a-z-]+)\/?$/.exec(hash || '');
  return m && Object.hasOwn(ROUTES, m[1]) ? m[1] : DEFAULT_ROUTE;
}
export const hashFor = (name) => `#/${name}`;

export function createRouter({ onChange } = {}) {
  let current = null;

  const depth = () => history.state?.i ?? 0;

  function show(name, { focus = false } = {}) {
    document.querySelectorAll('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== name; });
    document.title = name === DEFAULT_ROUTE ? 'NYX AI' : `${ROUTES[name].title} · NYX AI`;
    current = name;
    if (focus) document.querySelector(`[data-view="${name}"] h1`)?.focus({ preventScroll: true });
    onChange?.(name);
  }

  function go(name, { replace = false } = {}) {
    if (!Object.hasOwn(ROUTES, name)) name = DEFAULT_ROUTE;
    const hash = hashFor(name);
    if (name === current && location.hash === hash) return;
    if (replace) history.replaceState({ i: depth() }, '', hash);
    else history.pushState({ i: depth() + 1 }, '', hash);
    show(name, { focus: true });
  }

  function back() {
    if (depth() > 0) history.back();
    else go(ROUTES[current]?.parent ?? DEFAULT_ROUTE, { replace: true });
  }

  function start() {
    const name = parseHash(location.hash);
    history.replaceState({ i: depth() }, '', hashFor(name));
    show(name);
    window.addEventListener('popstate', () => show(parseHash(location.hash), { focus: true }));
    document.addEventListener('click', (e) => {
      const nav = e.target.closest?.('[data-nav]');
      if (nav) { e.preventDefault(); go(nav.dataset.nav); return; }
      if (e.target.closest?.('[data-back]')) { e.preventDefault(); back(); }
    });
  }

  return { start, go, back, get current() { return current; }, get depth() { return depth(); } };
}
