# NYX AI — project structure report

Stage 2 frontend with the connected Cloudflare Worker. Line counts are approximate. ZIP root = repository root (no enclosing folder).

```
NYX-AI/
├── index.html                  311  Single page: icon sprite, sidebar, 7 views, dialogs, toast, boot-error
├── manifest.webmanifest             PWA/Android metadata, icons
├── package.json                     Scripts + Capacitor dependencies (no frameworks); "type": "module"
├── capacitor.config.json            appId com.nyxai.app, webDir "www", HTTPS scheme, black background
├── .gitignore                       node_modules, www, android build output, secrets, keystores
├── README.md                        Usage, layouts, Termux/Android steps, integration plan, limitations
├── src/
│   ├── css/
│   │   ├── variables.css      200+  Design tokens; three themes (Pure Black / Deep Night / Light) × accents (violet/steel blue), text sizes, motion
│   │   ├── base.css            60   Reset, typography, focus ring, reduced-motion rules
│   │   ├── layout.css          96   App shell, top bar, drawer → icon rail → expanded sidebar, chat/composer layout
│   │   └── components.css     318   Buttons, chips, welcome + suggestion cards, bubbles, Markdown, composer, dialogs, settings
│   ├── js/
│   │   ├── app.js              66   Entry point: wires modules, viewport/keyboard height, global errors, back button
│   │   ├── chat.js            262   Messages, composer, attachments, scrolling, transport hook (Send/Stop/reveal)
│   │   ├── history.js          82   Conversation context sent to the Worker (bounded, cleaned, newest turn once)
│   │   ├── transport.js       117   Firebase-authenticated POST /chat, response size limit, error mapping
│   │   ├── reveal.js           17   Progressive reveal of the returned reply (not network streaming)
│   │   ├── sidebar.js         122   Drawer + collapsible rail, search, history, delete, swipe-to-close
│   │   ├── settings.js        124   Preferences, Appearance/Account/Memory behaviour, reset data
│   │   ├── models.js           79   FREE/PRO/MAX data, selector sheet, model information cards
│   │   ├── router.js           59   Hash router (#/chat, #/settings, …) with back handling
│   │   ├── store.js           106   Conversation model, search, date grouping, limits
│   │   ├── storage.js          61   Safe localStorage wrapper with in-memory fallback
│   │   ├── ui.js               98   Toast, confirm dialog, clipboard, icons, radio groups
│   │   ├── markdown.js        135   Safe Markdown renderer (escapes everything, http/https/mailto links only)
│   │   ├── highlight.js        70   Dependency-free syntax highlighter
│   │   ├── config.js           36   App info, BACKEND URL, conversation-history limits
│   │   └── util.js             18   escapeHtml, uid, formatBytes, plural
│   └── assets/
│       ├── logo/nyx-mark.png        NYX AI logo (supplied asset, 512 x 512 square)
│       └── icons/                   icon-192.png, icon-512.png, icon-maskable-512.png (from the logo)
├── resources/                       icon-only / foreground / background 1024px PNGs for @capacitor/assets
├── scripts/
│   ├── dev-server.js           65   Zero-dependency dev server (serves only index.html, manifest, src/)
│   ├── build.js                13   Copies the app into www/
│   ├── run-tests.js            10   Runs tests/unit with the built-in Node test runner
│   ├── generate-icons.mjs      30   Optional: regenerate PNG icons (needs sharp, not a dependency)
│   └── android-icons.mjs      430   Zero-dependency Android launcher-icon generator + verifier (see below)
├── tests/
│   ├── unit/                        markdown, state, wiring, project, features, context,
│   │                                android-icons (11), app-boot (6) — no dependencies
│   └── e2e/ui.test.mjs        537   Playwright browser tests (40 tests, optional)
└── docs/
    ├── STRUCTURE.md                 This report
    ├── TEST-REPORT.md               Results of the final test run
    └── android-debug-build.yml.example   Optional GitHub Actions APK build (untested)
```

## Module dependencies

`app.js` → storage, store, router, settings, models, chat, sidebar, ui.
`chat.js` → markdown, util, config, history, reveal, models, ui. `transport.js` → config, auth, models, history.
`markdown.js` → highlight, util. `sidebar.js` → store (grouping), util, ui.
Pure modules (no DOM at import time, unit-testable in Node): config, util, storage, store, history, router, models, markdown, highlight, settings (prefs).

## Changes in this refinement (0.2.0 → 0.2.1)

Modified: `index.html`, `variables.css`, `layout.css`, `components.css`, `chat.js`, `sidebar.js`, `app.js`, `config.js`, `package.json`, tests, README.
Added: `image` button + hidden image input, `sidebar-toggle` / `sidebar-search-btn` / `sidebar-models`, icons (image, panel), this `docs/` update.
Unchanged behaviour: routing, stores, settings, model selector, Markdown, transport hook, dev server, build.

## Conversation context (current branch)

Modified: `src/js/history.js` (new), `src/js/chat.js`, `src/js/transport.js`, `src/js/config.js`, `src/js/app.js`,
`backend/src/index.js`, `backend/test/index.test.js`, `tests/unit/context.test.js` (new), `tests/unit/project.test.js`,
`index.html` (logo), `scripts/generate-icons.mjs`, icon PNGs, README, docs.

- `history.js` builds the request messages from the open conversation only: user/assistant turns, newest turn last and
  once, notices/blank turns/empty placeholders dropped, bounded to 16 messages, 4000 characters per message and
  12000 characters in total.
- `chat.js` remembers the open conversation (`activeConversation`) so a reload or WebView restart continues the same
  chat, and explains attachment-only messages instead of sending an empty turn.
- `backend/src/index.js` re-validates the same rules (`buildConversationMessages`), keeps Firebase token verification,
  UID rate limiting and the FREE model id, and forwards the history to Workers AI with a continuity-aware system prompt.

## Android launcher icon (current branch)

Modified: `.github/workflows/android-debug.yml`, `package.json`, `src/js/chat.js`, README.
Added: `scripts/android-icons.mjs`, `tests/unit/android-icons.test.js`, `tests/unit/app-boot.test.js`.
Unchanged: the in-app logo, `resources/`, the Worker, the build, the app wiring.

`scripts/android-icons.mjs` derives the Android launcher icon from the official logo
(`src/assets/logo/nyx-mark.png`) into `android/app/src/main/res` — 22 files across the five density
buckets, the adaptive drawables and the `mipmap-anydpi-v26` adaptive XML. It uses only Node built-ins
(its own PNG codec), and it verifies what it wrote: valid PNG, exact size, the mark actually present
(average colour + detail), rounded corners where required, correct adaptive layers and resolvable XML
references. CLI flags: `--check` (verify only), `--out <dir>`, `--logo <png>`, `--check-apk <path>`.
Exit code 1 on any problem, so the workflow cannot package a broken icon.

`tests/unit/android-icons.test.js` generates into a temp directory and asserts the same properties,
plus failure modes (missing, corrupt, wrong size, wrong XML shape, empty tree) and CLI exit codes.

`tests/unit/app-boot.test.js` bundles the real `src/js/app.js` with Firebase stubbed out and drives it
in jsdom through sign-in, a message, a follow-up, a reload, a new chat and sign-out. It asserts that no
`error` or `unhandledRejection` is raised and that the generic "Something went wrong" toast is never
shown, and that a failure inside `send()` before the transport is reported as a conversation notice
rather than escaping to the global handler.

`src/js/chat.js` wraps the pre-transport part of `send()` in a try/catch: if the user message cannot be
stored, the conversation gets an error notice and the transport is never called, instead of the rejected
promise reaching `window`'s global error handler.
