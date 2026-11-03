# NYX AI — project structure report

Stage 2 (UI refinement 0.2.1). Line counts are from the delivered files. ZIP root = repository root (no enclosing folder).

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
│   │   ├── variables.css       91   Design tokens, themes (black/night), accents (violet/blue), text sizes, motion
│   │   ├── base.css            60   Reset, typography, focus ring, reduced-motion rules
│   │   ├── layout.css          96   App shell, top bar, drawer → icon rail → expanded sidebar, chat/composer layout
│   │   └── components.css     318   Buttons, chips, welcome + suggestion cards, bubbles, Markdown, composer, dialogs, settings
│   ├── js/
│   │   ├── app.js              66   Entry point: wires modules, viewport/keyboard height, global errors, back button
│   │   ├── chat.js            241   Messages, composer, attachments, scrolling, transport hook (Send/Stop/stream)
│   │   ├── sidebar.js         122   Drawer + collapsible rail, search, history, delete, swipe-to-close
│   │   ├── settings.js        124   Preferences, Appearance/Account/Memory behaviour, reset data
│   │   ├── models.js           79   FREE/PRO/MAX data, selector sheet, model information cards
│   │   ├── router.js           59   Hash router (#/chat, #/settings, …) with back handling
│   │   ├── store.js           106   Conversation model, search, date grouping, limits
│   │   ├── storage.js          61   Safe localStorage wrapper with in-memory fallback
│   │   ├── ui.js               98   Toast, confirm dialog, clipboard, icons, radio groups
│   │   ├── markdown.js        135   Safe Markdown renderer (escapes everything, http/https/mailto links only)
│   │   ├── highlight.js        70   Dependency-free syntax highlighter
│   │   ├── config.js           30   App info, BACKEND/SUPABASE placeholders (null), limits
│   │   └── util.js             18   escapeHtml, uid, formatBytes, plural
│   └── assets/
│       ├── logo/nyx-mark.svg        Original NYX AI mark (N + star)
│       └── icons/                   icon-192.png, icon-512.png, icon-maskable-512.png
├── resources/                       icon-only / foreground / background 1024px PNGs for @capacitor/assets
├── scripts/
│   ├── dev-server.js           65   Zero-dependency dev server (serves only index.html, manifest, src/)
│   ├── build.js                13   Copies the app into www/
│   ├── run-tests.js            10   Runs tests/unit with the built-in Node test runner
│   └── generate-icons.mjs      30   Optional: regenerate PNG icons (needs sharp, not a dependency)
├── tests/
│   ├── unit/                        markdown, state, wiring, project (40 tests, no dependencies)
│   └── e2e/ui.test.mjs        537   Playwright browser tests (40 tests, optional)
└── docs/
    ├── STRUCTURE.md                 This report
    ├── TEST-REPORT.md               Results of the final test run
    └── android-debug-build.yml.example   Optional GitHub Actions APK build (untested)
```

## Module dependencies

`app.js` → storage, store, router, settings, models, chat, sidebar, ui.
`chat.js` → markdown, util, config, ui. `markdown.js` → highlight, util. `sidebar.js` → store (grouping), util, ui.
Pure modules (no DOM at import time, unit-testable in Node): config, util, storage, store, router, models, markdown, highlight, settings (prefs).

## Changes in this refinement (0.2.0 → 0.2.1)

Modified: `index.html`, `variables.css`, `layout.css`, `components.css`, `chat.js`, `sidebar.js`, `app.js`, `config.js`, `package.json`, tests, README.
Added: `image` button + hidden image input, `sidebar-toggle` / `sidebar-search-btn` / `sidebar-models`, icons (image, panel), this `docs/` update.
Unchanged behaviour: routing, stores, settings, model selector, Markdown, transport hook, dev server, build.
