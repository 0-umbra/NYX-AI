# NYX AI — testing report

## Diagnostics reliability (follow-up to the field report)

The diagnostic record was audited against the six causes the investigation must separate. Three
defects were found and fixed, each with a mutation-checked regression test.

| Defect | Consequence in the field | Fix |
| --- | --- | --- |
| Provider-code regex matched `5xxx` only | `providerCode` was **null** for quota (3036), capacity (3040), too-large (3006) and timeout (3007) — the codes that matter most | Match both `3xxx` and `5xxx` |
| `3040` was only detected inside the quota branch | "out of capacity" could be reported as *exhausted quota, resets at 00:00 UTC* | Hoisted above the quota branch |
| `logVisionFailure` passed `stage`/`category` through unvalidated | A caller passing provider text would leak it into logs | Format-checked allowlist; a failing record is dropped, not logged |

Also added: `stage=validation.image|validation.document` records, so a payload rejected **before**
inference (base64, magic bytes, size caps) is no longer invisible — previously indistinguishable
from a model failure.

Verified distinct: CPU/resource-limit (`AI_RESOURCE_LIMIT`, 1102) · base64 decode
(`AI_INVALID_BASE64`) · provider failure (`AI_FAILED` + status) · model unavailable
(`AI_MODEL_UNAVAILABLE`, 5007) · quota (`AI_QUOTA`, 3036) / capacity (`AI_OUT_OF_CAPACITY`, 3040) ·
malformed response (`AI_BAD_RESPONSE`) / empty (`AI_EMPTY`).

Sanitization was tested adversarially, not just inspected: a provider error embedding image data,
a file name, a prompt and a token in its message produces exactly one clean record; a caller passing
hostile values directly into the record fields gets the record dropped.

**Still not established:** the real production cause. Nothing here was captured from production —
no `wrangler tail` output, no provider error code. See `docs/CAPTURE-PRODUCTION-FAILURE.md` for the
read-only procedure; it has not been run.

## PDF ArrayBuffer-detachment fix + image-inference diagnosis (current branch)

All results below were produced by commands executed on this branch. Nothing is estimated. The
Cloudflare Worker was **not deployed** (dry run only) and **Android WebView was not tested** (no
Android SDK/Gradle/Java and no device in this environment).

| Suite | Command | Result |
| --- | --- | --- |
| Frontend unit + static checks | `npm test` | **200 / 200 passed**, 0 failed |
| PDF detachment regressions | `node --test tests/unit/pdf-buffer.test.js` | **33 / 33 passed** |
| Transport failure/notice regressions | `node --test tests/unit/transport-image-errors.test.js tests/unit/transport-notices.test.js` | **25 / 25 passed** |
| Backend (Worker) tests | `cd backend && npm test` | **94 / 94 passed** |
| Image-inference regressions | `cd backend && node --test test/image-inference.test.js` | **38 / 38 passed** |
| Production build | `npm run build` | Built `www/`, incl. `www/vendor/pdf.worker.min.mjs` |
| Worker compile | `cd backend && npx wrangler deploy --dry-run` | Compiled; bindings `env.AI`, `env.CHAT_LIMITER` |
| Android launcher icon | `node scripts/android-icons.mjs --check` | 22 files verified |
| `git diff --check` | — | clean |
| Android debug APK / Playwright | CI on the PR | see the PR checks |
| Android WebView device testing | — | **not performed here** |

### PDF fix — confirmed root cause (two distinct parts)

`pdfjs-dist` **5.7.284**; `legacy/build/pdf.mjs:21611`:
`worker.messageHandler.sendWithPromise("GetDocRequest", docParams, data ? [data.buffer] : null)` —
the buffer is a **transferable**, so **every** `getDocument()` call detaches the buffer it is given.

1. **First-load detachment — always.** Every PDF.js document load consumes its input buffer.
2. **Conditional OCR reuse — the crash that was reported.** The old pipeline held a single buffer
   for the whole document and reused it for the page-rendering pass. That pass runs only when
   `likelyScanned` is true, i.e. when the extracted text layer has **fewer than 25 non-space
   characters** — not simply "the PDF is scanned". A long text PDF therefore took one load and
   worked; a scanned PDF, or any PDF whose text layer is nearly empty, took a second load on a
   detached buffer and threw *"Cannot perform Construct on a detached ArrayBuffer"*.

This was verified against a reconstruction of the pre-fix pipeline:

| Fixture | Pre-fix result |
| --- | --- |
| Long text layer (≥ 25 chars) | **succeeded** — one load only |
| Short text layer ("Short note") | **failed** — classified scanned, second load |
| No text layer (scanned) | **failed** — second load |

So "every tested PDF failed" is consistent with all seven of those files being scanned or
short-text; it is not evidence that long-text PDFs failed, and this report does not claim that.

### Copy accounting (measured, not asserted)

`createCopyReport()` records every whole-document byte copy the pipeline performs. The contract,
asserted in `tests/unit/pdf-buffer.test.js`:

| Document | Copies |
| --- | --- |
| Text PDF (one document load) | **1 snapshot + 1 transferable copy = 2** |
| Scanned PDF (text load + OCR load) | **1 snapshot + 2 transferable copies = 3** |

Copies are **per document load**, never per page: the same 2 copies were measured for a 1-page and
a 40-page PDF. Independent confirmation, using `--expose-gc` heap accounting
(`process.memoryUsage().arrayBuffers`) on an 8 MiB document rather than the pipeline's own
instrumentation: constructing an arena holds **+8.00 MiB**, and one `load()` holds **+8.00 MiB**
only while that copy is alive. Peak transient memory is therefore snapshot + one copy, even for a
scanned PDF, because each copy is released (and detached by PDF.js) before the next is made.

### Image investigation — what was found (and what is not proven)

Not the same cause as the PDF bug. Two separate defects were found:

1. **Measured local decode cost.** `decodeDataUriImage()` decoded base64 with
   `Uint8Array.from(binary, (c) => c.charCodeAt(0))` — a JS callback per byte. Measured locally
   (Node 22): **13.8 ms** for 100 KiB decoded, **104.2 ms** for 1 MiB, **148.9 ms** for 1.4 MiB
   (the client's re-encode ceiling). The indexed loop does the same work in **0.4 / 2.9 / 5.6 ms**
   and returns byte-identical output. `atob` itself is unchanged and negligible.
2. **Error mapping.** The Worker collapsed every vision failure into one opaque 502, and the
   frontend replaced even that with "check your connection". Failures are now classified, logged
   once as a sanitized structured record (stage, category, status, Workers AI numeric code only)
   and mapped to distinct, actionable, sanitized messages.

**The Cloudflare CPU-limit explanation has been REFUTED by production evidence.** The 56–102 ms
decode cost measured here is real, and the indexed-loop fix is a genuine improvement, but CPU
exhaustion is **not** what broke image analysis. A production capture (2026-11-10 12:29 IST) shows
the Worker emitting its own line, `Workers AI vision request failed.` — which this code reaches only
*after* base64 decoding and validation succeed — and then returning a 502. A CPU-killed isolate is
terminated and cannot log and respond.

What the capture establishes: the request reached the vision call, so auth, body limits, JSON
parsing, attachment validation, base64 decoding and the magic-byte check all passed. What it cannot
establish: *why* the provider call failed, because the deployed code maps seven distinct causes onto
that one string. **Real production image inference therefore remains unverified and unfixed.** The
diagnostics in this PR are what will identify the cause on the first failing request after deploy.

**Not verified at all:** live Workers AI / Moondream inference. There are no Cloudflare credentials
or network access to the Worker here, so no real image inference was performed. Tests use a mocked
`env.AI` and prove request shape, response parsing, failure mapping and diagnostics — not that the
deployed model answers.

---

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
