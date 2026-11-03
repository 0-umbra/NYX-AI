# NYX AI

**Intelligence beyond limits.**

NYX AI is an Android-first AI assistant. This repository holds the **Stage 2 frontend**: a complete, working chat
interface in plain HTML, CSS and vanilla JavaScript, packaged for Android with Capacitor.

> **The AI backend is not implemented yet.** The app says so on screen and never fakes a reply.
> Voice input, sign-in and memory are interface previews only.

## Quick start

Requires Node.js 20 or newer. No `npm install` is needed to run the app — the dev server has zero dependencies.

```bash
npm run dev      # http://localhost:5173
npm test         # 40 unit and static checks (no dependencies)
npm run build    # copies the app into www/ for Capacitor
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Static dev server (127.0.0.1:5173). `PORT=8080 npm run dev` changes the port; `HOST=0.0.0.0 npm run dev` exposes it on your Wi-Fi. |
| `npm test` | Syntax, wiring, markdown, state, package and dev-server tests using Node's built-in runner. |
| `npm run test:e2e` | 40 browser tests (needs Playwright; run on a PC or CI, not Termux). |
| `npm run build` | Builds `www/` (the Capacitor `webDir`). |
| `npm run cap:add:android` / `cap:sync` / `cap:open` | Capacitor helpers (need `npm install` first). |

## Layouts

| Screen | Layout |
| --- | --- |
| **Phone** (under 700px) | Full-screen chat. Compact top bar: menu, centred model selector, new chat. Greeting centred, prompt chips just above the composer. Sidebar is a slide-in drawer (scrim, swipe-left, Escape, Android back). |
| **Tablet** (700px and up) | Persistent sidebar that starts as a 68px icon rail. Welcome screen with three suggestion cards. |
| **Desktop** (1100px and up) | Sidebar starts expanded (300px) with navigation and recent chats; collapse or expand it any time (remembered). Large rounded composer, centred welcome. |

Composer controls: attachment, image, voice (interface only), send, and stop (appears while a transport is streaming).

## Features

- Chat: new chat, user and assistant bubbles, copy message, copy code, safe Markdown, syntax highlighting, smooth auto-scroll with a jump-to-latest button, keyboard-aware layout.
- Sidebar: search, recent conversations grouped by date, delete with confirmation, navigation, profile.
- Model selector: FREE, PRO and MAX with descriptions. **Selection only** — no model is connected.
- Screens: Settings, Appearance (theme, accent, text size, reduced motion), Account, Memory (preview), Model information, About.
- Accessibility: labelled controls, roving-tabindex radio groups, focus management, `prefers-reduced-motion` and an in-app reduce-motion switch.
- Lightweight: about 110 KB uncompressed (about 30 KB gzipped) for the whole app, no frameworks, no web fonts, no remote requests.

## Project structure

See [`docs/STRUCTURE.md`](docs/STRUCTURE.md) for the annotated tree. In short:

```
index.html  manifest.webmanifest  capacitor.config.json  package.json
src/css/    variables.css  base.css  layout.css  components.css
src/js/     app.js  chat.js  sidebar.js  settings.js  models.js  (+ router, store, storage, ui, markdown, highlight, config, util)
src/assets/ logo/  icons/
scripts/    dev-server.js  build.js  run-tests.js  generate-icons.mjs
tests/      unit/  e2e/
docs/       STRUCTURE.md  TEST-REPORT.md  android-debug-build.yml.example
resources/  icon sources for @capacitor/assets
```

## Android with Capacitor

```bash
npm install                   # installs Capacitor
npm run cap:add:android       # builds www/ and creates android/ (once)
npx @capacitor/assets generate --android   # optional: app icons from resources/
npm run cap:sync              # after every change to the web app
npm run cap:open              # opens Android Studio (on a PC)
```

Building an APK needs the Android SDK, Java 21 and Gradle — not practical inside Termux. Either build on a PC, or let GitHub
Actions do it: copy `docs/android-debug-build.yml.example` to `.github/workflows/android-debug.yml` on `develop`
(it is untested and triggers only on `develop`).

## Termux (Android phone only)

```bash
pkg update && pkg upgrade -y
pkg install -y git nodejs-lts unzip         # if nodejs-lts is unavailable: pkg install nodejs
termux-setup-storage                        # once; lets Termux read ~/storage/downloads

git clone https://github.com/0-umbra/NYX-AI.git
cd NYX-AI
git checkout develop                        # never work on main

unzip -o ~/storage/downloads/NYX-AI-Stage2.zip   # project files go straight into this folder
git status                                  # review: README.md and .gitignore may differ from the old ones
npm test
npm run dev                                 # leave running
```

Open **Chrome** on the same phone and visit `http://localhost:5173`. Use Chrome's menu → *Add to Home screen* for an app-like launcher.
Stop the server with `Ctrl+C` in Termux.

Commit to `develop` only:

```bash
git add -A
git commit -m "Stage 2: responsive NYX AI frontend"
git push origin develop
```

## Future integration (preserved requirements)

The app is structured so the backend can be added without touching the UI:

- **Cloudflare Workers** — the API gateway. The app must never hold provider keys; the Worker keeps them as secrets, applies the chosen tier
  (`free`, `pro`, `max`) and streams the reply. Allow the CORS origins `https://localhost` (Capacitor Android default) and your dev origin.
  Put only the public Worker URL in `BACKEND.baseUrl` (`src/js/config.js`).
- **Supabase** — accounts, conversation sync and memory. Put only the public project URL and **anon** key in `SUPABASE` (`config.js`);
  protect data with Row Level Security. Never ship the service-role key.
- **Chat transport** — register one function and the Send/Stop/streaming/Markdown UI works end to end:

```js
// Stage 3 — streams text chunks; throw Error to show an error notice; honour `signal` for Stop
NYX.chat.setTransport(async function* ({ conversationId, messages, model, signal }) {
  const res = await fetch(`${BACKEND.baseUrl}/chat`, { method: 'POST', signal, body: JSON.stringify({ messages, model }) });
  // ...yield decoded text chunks
});
```

  `src/js/store.js` already uses a plain-JSON conversation model that maps cleanly to a Supabase table.

## Git workflow

Work on `develop`. **Never modify `main`** (protected). Do not commit `node_modules/`, `www/`, keystores or `.env` files — `.gitignore` covers them.

## Known limitations

- **No AI backend.** No replies, voice input, sign-in or memory; attachments are kept as metadata only and are never uploaded.
- **Not run on a physical Android device or in a built APK.** Behaviour was tested in headless Chromium with phone-sized viewports and an emulated shrinking viewport for the soft keyboard. The optional Capacitor back-button hook is untested; without it the WebView falls back to normal history navigation.
- **Capacitor install, sync and Gradle build were not run** (no network or Android SDK where this was built). Versions in `package.json` (`^7`) need a first `npm install`.
- Conversations live in `localStorage` (capped at 100 chats × 500 messages each). Clearing browser/app data deletes them.
- The Markdown renderer is deliberately small: no images, raw HTML, task lists or footnotes. Highlighting covers JS/TS, Python, shell, JSON, CSS and HTML.
- Dark themes only (Pure black and Deep night). Status/navigation bar colours use Android defaults (no StatusBar plugin).
- No offline service worker (not needed inside the Capacitor app).
- The `README.md` and `.gitignore` in this archive replace the repository's originals — diff before committing and merge anything you want to keep.
