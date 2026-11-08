# NYX AI — testing report

## Conversation context update (current branch)

All results below come from commands executed on this branch. Nothing is estimated; the
Cloudflare Worker was **not deployed** (dry run only) and the optional Playwright suite was **not** run.

| Suite | Command | Result |
| --- | --- | --- |
| Frontend unit + static checks | `npm test` | **79 / 79 passed**, 0 failed (~21 s) |
| Android launcher icon | `node scripts/android-icons.mjs` | **22 files generated and verified** (exit 0) |
| Android launcher icon regressions | `node --test tests/unit/android-icons.test.js` | **11 / 11 passed** |
| App boot / session-flow regressions | `node --test tests/unit/app-boot.test.js` | **6 / 6 passed** |
| Conversation-context regressions | `node --test tests/unit/context.test.js` | **17 / 17 passed** |
| Backend (Worker) tests | `cd backend && npm test` | **29 / 29 passed** (~0.4 s) |
| Production build | `npm run build` | Built `www/` (index.html, manifest, bundled `app.bundle.js`, logo and icons) |
| Worker compile | `cd backend && npx wrangler deploy --dry-run` | Compiled, 10.93 KiB upload / 3.74 KiB gzip; bindings `env.AI`, `env.CHAT_LIMITER` |
| Android build | `.github/workflows/android-debug.yml` | Not run (no Android SDK / Gradle / Java in this environment) |
| Browser end-to-end | `npm run test:e2e` | Not run (Playwright/Chromium are not installed here) |

Conversation-context cases covered: related follow-up, pronoun follow-up ("he", "that character"),
several follow-ups in one chat, a new chat starting empty, switching between two chats without mixing
histories, reopening an older conversation, a long conversation using a bounded window, the newest
message sent exactly once, local notices / blank messages / empty placeholders never sent, the open
conversation restored after a reload, and the Worker forwarding + validating history (leading assistant
dropped, blank turns ignored, client `system` messages rejected, 24-message cap, oversized history
trimmed from the oldest turn, oversized body rejected).

`tests/unit/app-boot.test.js` bundles the real `src/js/app.js` with Firebase stubbed and drives it in
jsdom through boot, sign-in, a message, a follow-up, a reload, a new chat and sign-out. It asserts that
no `error` / `unhandledRejection` is raised, that the generic "Something went wrong. Please try again."
toast is never shown, and that a failure inside `send()` before the transport is reported as a
conversation notice. The negative control was checked: removing the `try/catch` in `send()` makes that
test fail.

Not verified here: a live call to the deployed Worker and Workers AI with a real Firebase session
(no credentials or network access in this environment). The FREE model id, authentication, origin
checks, UID rate limiting and progressive reveal are unchanged.

---

## Android launcher icon (current branch)

`scripts/android-icons.mjs` derives the launcher icon from the official logo
(`src/assets/logo/nyx-mark.png`, 512 x 512) and writes it to `android/app/src/main/res`. It uses only
Node built-ins, and it verifies what it wrote:

- **22 files**: `mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png` + `ic_launcher_round.png`
  (48/72/96/144/192), `drawable-<density>/ic_launcher_foreground.png` + `ic_launcher_background.png`
  (108/162/216/324/432), `mipmap-anydpi-v26/ic_launcher.xml` + `ic_launcher_round.xml`.
- **Verified per file**: exists, is a valid PNG (round-tripped through the script's own decoder), is the
  exact required size, square icons carry the NYX AI mark (centre opaque, ≥ 4 distinct colours, average
  colour within tolerance of the source logo, high-frequency detail present), round icons have
  transparent corners, foregrounds have transparent corners + opaque centre, backgrounds are uniform, and
  the adaptive XML declares `<adaptive-icon>` with resolvable `@drawable` references.
- **Determinism**: running it twice produces byte-identical files.
- **Failure modes reproduced**: missing file → exit 1 with 22 "missing …" problems; corrupt PNG → "not a
  PNG file"; wrong dimensions → "expected 192x192, found 10x10"; wrong XML shape → 3 problems; empty tree
  → 22 problems; `--check-apk` on an APK with no icons → 22 problems.
- **APK inspection**: `--check-apk` reads a ZIP (stored + deflate), maps `res/mipmap-*/…` and
  `res/drawable-*/…` to the expected files and confirms the bytes are identical.
- **Visual check**: the generated square icons are full-bleed dark-navy with the logo; the round icons keep
  the logo centred with transparent corners; the adaptive foreground is the logo at 66 % centred with
  transparent margins.

`.github/workflows/android-debug.yml` runs the generator after `npx cap sync android` and the verifier
against `app-debug.apk` after `./gradlew assembleDebug`, so a broken launcher icon fails the workflow.

Not verified here: a real Android build (no Android SDK / Gradle / Java in this environment), so the
workflow itself was reviewed but not executed end to end.

---

# Earlier run — Stage 2, UI refinement 0.2.1

All results below come from the final run on the delivered source. Nothing is estimated.

## Summary

| Suite | Command | Result |
| --- | --- | --- |
| Unit + static checks | `npm test` | **40 / 40 passed**, 0 failed (1.4 s) |
| Browser end-to-end | `npm run test:e2e` | **40 / 40 passed**, 0 failed (35 s) |
| Dev server | `PORT=5199 node scripts/dev-server.js` | Starts, serves `/`, `src/*`, manifest; blocks traversal, dotfiles, `package.json`, `tests/` |
| Console | every e2e test | **No console errors/warnings, page errors, failed requests or HTTP ≥ 400** (asserted after each test) |

**Environment:** Node 22.22.2, Chromium (Playwright 1.56, headless). Phone tests use a 360×780 touch/mobile context (also 320 and 412 wide, and 360×440 to emulate an open soft keyboard);
tablet 768×1024; desktop 1280×800 and 1100×760.

## What the tests cover (requirements checklist)

| Requirement | Tested by |
| --- | --- |
| JavaScript syntax | `node --check` on every `.js/.mjs` in src, scripts and tests |
| Navigation (no broken links) | Every `data-nav` target is a route; every view reachable from Settings; Back from each screen; deep links; unknown hash → chat; browser back |
| Model selector | FREE/PRO/MAX, descriptions, arrow keys, persistence after reload, Compare tiers, model cards |
| Chat input | Disabled when empty/whitespace, send, textarea growth/cap, voice is honest, attachments, image button, copy message/code |
| Honesty (no fake AI) | No assistant bubble is created without a transport; "AI backend not connected" notice on welcome, composer and each sent message |
| Sidebar | Open/close (button, scrim, Escape), inert when closed, search, empty states, delete confirm/cancel, rail collapse/expand/persist, rail search |
| Settings navigation | Settings → Appearance, Account, Memory, Model information, About, and back |
| Responsive layout | Phone, tablet and desktop layouts, top bar position, centred model selector, suggestion chips vs cards, composer size |
| Keyboard handling | Viewport shrink to 440 / 420 px: composer on screen, welcome not clipped, latest message visible |
| Scrolling | Stays pinned while messages arrive (smooth), jump-to-latest button, instant when reduced motion is on |
| Overflow | No horizontal overflow on any screen at 320, 360 and 412 px (chat with long code/table/URL, sidebar, all 6 other screens) and on tablet/desktop |
| Missing assets | All images load; manifest icons exist with the declared dimensions; every local `src`/`href`/import resolves |
| Package configuration | Scripts point at real files; only `@capacitor/*` dependencies; valid `capacitor.config.json`; `npm run build` creates a complete `www/` |
| Security | Markdown XSS (`<script>`, `javascript:` links, attribute breakout) in unit and browser tests; secret-pattern scan; no `fetch`/XHR/WebSocket in `src/js` |
| Accessibility | Labels on inputs/buttons/dialogs, `role=switch/radio/log`, touch targets ≥ 40 px |

## Unit and static tests (`npm test`) — 40 passed

1. ✅ escapes raw HTML (XSS)
2. ✅ only http(s) and mailto links become anchors
3. ✅ quotes in link URLs cannot break out of the attribute
4. ✅ inline formatting
5. ✅ headings, rules and paragraphs
6. ✅ lists: nesting and ordered/unordered switching
7. ✅ blockquotes and tables
8. ✅ fenced code blocks are highlighted, escaped and copyable
9. ✅ unclosed code fence (streaming) renders as code
10. ✅ highlighter: languages, aliases and unknown languages
11. ✅ package.json: required scripts exist and point at real files
12. ✅ package.json: no frameworks and only Capacitor dependencies
13. ✅ capacitor.config.json: valid app id, name and webDir produced by the build
14. ✅ build produces a complete www/ directory
15. ✅ dev server: serves the app, blocks traversal, dotfiles and non-web files
16. ✅ repository hygiene: .gitignore, README, no secrets, no node_modules
17. ✅ storage: round-trips JSON, falls back on corrupt data, clears only its namespace
18. ✅ storage: works (in memory) when localStorage is blocked or missing
19. ✅ store: create, add messages, title from first user message, search, delete
20. ✅ store: ignores invalid input and sanitises corrupt saved data
21. ✅ store: attachments keep metadata only; message cap enforced
22. ✅ store: conversation cap enforced
23. ✅ groupByDate buckets conversations
24. ✅ titleFrom trims and truncates
25. ✅ prefs: defaults, validation, persistence, reset
26. ✅ router: parses hashes and every route has a valid parent chain ending at chat
27. ✅ models: FREE / PRO / MAX with descriptions
28. ✅ util + config
29. ✅ every JavaScript file passes a syntax check
30. ✅ HTML: unique ids, language, viewport and a single h1 per view
31. ✅ every id used by JavaScript exists in the HTML
32. ✅ navigation: data-nav targets and data-view sections match the route table
33. ✅ icons: every referenced symbol exists in the sprite
34. ✅ assets: every local file referenced by HTML, CSS, JS and the manifest exists
35. ✅ manifest icons have the declared dimensions
36. ✅ CSS: balanced braces and every var(--x) is defined
37. ✅ CSS: every class used in the HTML and in static JS templates is styled
38. ✅ layout safety: no fixed pixel widths that could overflow a 320px screen
39. ✅ no remote dependencies and no network calls in the app (no fake backend)
40. ✅ accessibility basics: labelled buttons, inputs and dialogs

## Browser tests (`npm run test:e2e`) — 40 passed

1. ✅ starts cleanly: welcome screen, tagline and backend-not-connected notice
2. ✅ chat input: send disabled when empty, enabled with text, message + honest notice, no fake reply
3. ✅ textarea grows with content and caps its height; long words do not overflow
4. ✅ new chat resets the conversation; history lists both; opening restores messages
5. ✅ sidebar: opens, closes via scrim / close button / Escape, traps nothing when closed
6. ✅ sidebar: search filters, shows empty states, and delete asks for confirmation
7. ✅ empty history shows a helpful message
8. ✅ model selector: FREE/PRO/MAX with descriptions, selection persists across reload
9. ✅ model sheet: Compare tiers opens Model information; cards select a tier
10. ✅ settings navigation: every screen opens and Back returns correctly
11. ✅ deep links and browser/hardware back: no broken navigation
12. ✅ appearance: theme, accent and text size apply instantly and persist
13. ✅ account: display name updates the sidebar profile; delete-all resets everything
14. ✅ memory screen: preview switches toggle and are labelled as having no effect
15. ✅ about and model information screens show honest status
16. ✅ attachments: add, show chips, remove, send as metadata; limits enforced
17. ✅ voice button is interface-only and says so
18. ✅ copy buttons work for messages and code blocks
19. ✅ transport hook: streams markdown into an assistant bubble; Stop aborts and keeps the partial reply
20. ✅ transport errors show an error notice and never crash the UI
21. ✅ markdown from untrusted text is rendered safely
22. ✅ keyboard-aware layout: composer stays on screen when the viewport shrinks
23. ✅ no horizontal overflow on any screen at 320px
24. ✅ no horizontal overflow on any screen at 360px
25. ✅ no horizontal overflow on any screen at 412px
26. ✅ touch targets: interactive controls are at least 40px
27. ✅ every image and asset loads (no missing assets)
28. ✅ wide screens keep the sidebar visible as a column
29. ✅ mobile: compact top bar with menu left, model selector centred, new chat right
30. ✅ mobile welcome: centred greeting, prompt chips just above the composer
31. ✅ suggestions only fill the composer — they never send or fake a reply
32. ✅ composer: attachment, image, voice and send controls are present and tappable
33. ✅ image button attaches images as metadata with an image icon; nothing is uploaded
34. ✅ keyboard open (short viewport): welcome stays fully visible and the composer is usable
35. ✅ smooth scrolling: stays pinned to new messages; jump button appears after scrolling up
36. ✅ reduced motion: scrolling is instant and ambient animation is off
37. ✅ tablet (768px): persistent sidebar starts as an icon rail and expands on demand
38. ✅ desktop (1280px): expanded sidebar, three suggestion cards, centred model selector, large composer
39. ✅ desktop: sidebar collapses to a rail, remembers the choice, and the rail search expands it
40. ✅ desktop: model selector opens as a centred dialog (not a bottom sheet) and settings pages stay usable

## Measurements

| Metric | Result |
| --- | --- |
| App size (HTML + CSS + JS) | 110 KB raw, about 29 KB gzipped (HTML 5.5, CSS 7.4, JS 16.4) |
| Remote requests / web fonts / frameworks | none |
| Cold start with 4× CPU throttle (low-end phone proxy) | app ready in 976 ms (including page load) |
| DOM size | 506 nodes at start; 1,113 after 40 messages |
| JS heap after 40 messages | about 10 MB |
| Animations | One infinite transform/opacity animation (welcome glow, compositor-only), none when reduced motion is on; no blur/backdrop filters |

## Problems found by testing and fixed during this run

1. List parser merged an ordered list into the preceding bullet list — fixed.
2. Welcome screen was scrolled out of view (logo clipped) when the viewport was short, as with the keyboard open — fixed (welcome always starts at the top, hero compacts on short screens).
3. Sidebar rail animated from 300 px to 68 px on first paint — fixed (no transition while booting).
4. A message appended during a smooth scroll left the newest notice partly below the fold — fixed.
5. Hidden file input and several test-selector issues (assistant avatar counted as an image, timing around transitions) — fixed.

## Not tested (be aware)

- **No physical Android device, real soft keyboard, or built APK.** Keyboard handling was verified by resizing the viewport the way `adjustResize` does; confirm on a real phone.
- **`npm install`, `cap add/sync`, Gradle build** — no network or Android SDK in the build environment. `@capacitor/*` `^7` versions are unverified.
- Capacitor `App.backButton` hook (guarded; falls back to WebView history if the plugin is absent).
- Termux itself (Node 22 in a desktop Linux environment was used; scripts use only Node built-ins).
- Screen readers (TalkBack) — only structural accessibility checks were automated.
