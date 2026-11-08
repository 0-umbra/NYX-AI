/** NYX AI — application entry point. Wires modules together; contains no feature logic of its own. */
import { storage } from './storage.js';
import { createStore } from './store.js';
import { createRouter } from './router.js';
import { createPrefs, applyPrefs, initSettings } from './settings.js';
import { initModels } from './models.js';
import { initChat } from './chat.js';
import { createTransport } from './transport.js';
import { initAuth } from './auth.js';
import { initSidebar } from './sidebar.js';
import { $, toast, closeTopDialog } from './ui.js';

function bindViewport() {
  const root = document.documentElement;
  const vv = window.visualViewport;
  const apply = () => root.style.setProperty('--app-h', `${Math.round(vv ? vv.height : window.innerHeight)}px`);
  vv?.addEventListener('resize', apply);
  window.addEventListener('resize', apply);
  apply();
}

function bindGlobalErrors() {
  const report = (err) => { console.error('[NYX]', err); toast('Something went wrong. Please try again.'); };
  window.addEventListener('error', (e) => report(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => report(e.reason));
}

function bindBackButton({ router, sidebar }) {
  // Capacitor's App plugin (optional). Without it, the WebView falls back to history navigation.
  const App = window.Capacitor?.Plugins?.App;
  App?.addListener?.('backButton', () => {
    if (closeTopDialog()) return;
    if (sidebar.isOpen()) { sidebar.close(); return; }
    if (router.current !== 'chat' || router.depth > 0) { router.back(); return; }
    App.exitApp?.();
  });
}

function showFatal(err) {
  console.error('[NYX] boot failed', err);
  const box = $('boot-error');
  if (box) box.hidden = false;
}

function boot() {
  const prefs = createPrefs(storage);
  applyPrefs(prefs.all());
  bindViewport();
  bindGlobalErrors();

  const store = createStore(storage);
  let chat;
  let sidebar;
  const router = createRouter({ onChange: (name) => { if (name === 'chat') chat?.scrollToBottom(); else sidebar?.close({ restoreFocus: false }); } });
  const models = initModels({ storage, onCompare: () => router.go('models') });
  chat = initChat({ store, getModelId: () => models.id });
  chat.setTransport(createTransport);
  sidebar = initSidebar({ store, chat, router, storage });
  initSettings({ prefs, store, storage });
  router.start();
  initAuth({ prefs, onSession: (user) => {
    if (!user) {
      chat.newChat();
      sidebar.close({ restoreFocus: false });
      while (closeTopDialog()) { /* dismiss dialogs on sign out */ }
    }
    router.go('chat', { replace: true });
  } });
  bindBackButton({ router, sidebar });

  // Debug / integration handle. Stage 3 registers its transport via NYX.chat.setTransport(fn).
  requestAnimationFrame(() => requestAnimationFrame(() => $('app').classList.remove('is-booting')));

  window.NYX = Object.freeze({ chat, store, router, models, prefs });
}

try { boot(); } catch (err) { showFatal(err); }
