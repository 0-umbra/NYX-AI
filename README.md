# NYX AI

NYX AI is an Android-first chat app using Firebase Email/Password authentication and a Cloudflare Worker with Workers AI. The FREE tier is available; PRO and MAX are locked for future integration. No subscription or paid API has been added. Cloudflare and Firebase service quotas and account terms still apply.

## Development

Requires Node.js 20 or newer and npm. The locked Firebase dependencies currently warn that Node 24.12 or newer is required; use a compatible Node version.

```sh
npm ci
npm run dev       # builds and serves the bundled app on 127.0.0.1:5173
npm test          # frontend unit/integration checks
npm run build     # production bundle in www/ for Capacitor
cd backend
npm ci
npm test
npx wrangler deploy --dry-run
```

Set `HOST=0.0.0.0` to expose the dev server, and `PORT` to change the port. Re-run the dev server after source changes; it serves the production bundle so Firebase's npm imports work in the browser. `npm run test:e2e` is an older optional Playwright suite and requires Playwright and Chromium; parts of that suite predate authentication and the connected backend.

For Android, build and run `npx cap sync android` after setting up the Android project and SDK. Firebase Email/Password must be enabled and the app's origins configured in Firebase and the Worker. The app sends Firebase ID tokens to the existing Worker; provider credentials belong only on the server. The Worker validates authentication, origins, message limits and rate limits. See `backend/wrangler.jsonc` for bindings. Do not deploy without reviewing configuration.

### Android launcher icon

The Android launcher icon is the density buckets under `android/app/src/main/res/`, which Gradle packages into the APK — it is not the in-app logo, and `npx cap add android` scaffolds its own placeholder. `scripts/android-icons.mjs` derives the launcher icon from the official logo (`src/assets/logo/nyx-mark.png`) and writes it into that tree:

- `mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png` and `ic_launcher_round.png` (48/72/96/144/192) for every Android version;
- `drawable-<density>/ic_launcher_foreground.png` (108 dp × density) with the mark inside the 66 dp safe zone, and `ic_launcher_background.png` on the app's black;
- `mipmap-anydpi-v26/ic_launcher.xml` / `ic_launcher_round.xml` referencing those drawables.

It uses only Node built-ins, so it runs from a clean checkout. Run it after `cap sync` — which may rewrite the Android resource tree from `resources/` — then build:

```sh
npm run icons:android                              # generate + verify (fails the build on any problem)
node scripts/android-icons.mjs --check            # verify an existing resource tree only
node scripts/android-icons.mjs --check-apk <apk>  # confirm the icons are inside the built APK
```

Verification checks that every required file exists, is a valid PNG of the right size, actually contains the NYX AI mark (average colour and detail, not a flat fill), that round icons are masked, adaptive layers are correct and the adaptive XML resolves. `.github/workflows/android-debug.yml` runs it before Gradle and again against the APK, so a broken launcher icon fails the workflow instead of being packaged. Tests: `tests/unit/android-icons.test.js`.

## Data and behaviour

Conversations, titles and pins are stored locally, not synced or partitioned by account. Signing out does not erase them; anyone using this device and signing in can see them. Clearing app data deletes local history. Voice and memory are previews. Worker replies are complete JSON responses: the frontend progressively reveals the returned text, not genuine streaming. Stopping a reveal retains only the text shown so far. PRO and MAX cannot be selected or sent to the Worker.

## Attachments

Attach images (JPEG, PNG, WebP) and documents (PDF, TXT, Markdown, JSON, CSV) straight into the composer — multiple files per message, with thumbnails and document cards, per-file type labels and sizes, processing status, and per-file remove and retry controls. Nothing the model cannot genuinely read is ever faked or hinted at via the filename.

- **On-device first.** Images are decoded, downscaled (max 1024 px edge) and re-encoded on the device until they fit the wire budget; PDF text is extracted locally with PDF.js; TXT/Markdown/JSON/CSV are read directly. Only the extracted content (an image payload, or a document's text) is sent to the authenticated Worker — original files are never uploaded or retained, and nothing is written to Worker storage.
- **Image understanding.** The Worker runs one bounded query per image against the Cloudflare Workers AI vision model `@cf/moondream/moondream3.1-9B-A2B` (query task, no reasoning trace) and feeds the resulting analysis into the FREE chat model. This covers OCR/visible-text transcription, screenshot understanding, object identification, diagram/chart questions and image question answering, in one message across multiple images.
- **Scanned PDFs.** A PDF with no usable text layer is detected on-device and rendered page by page (first 3 pages, JPEG) and read by the vision model the same way. The composer says how many pages were read; the text is merged into the message so follow-ups keep working.
- **Conversation context.** The Worker is stateless, so every request carries the conversation. Extracted content is persisted on-device with the message (bounded: analyses ≤ 1600 chars, document text ≤ 4000 chars) and folded into future turns, so "what did that PDF say about churn?" keeps working without re-uploading. Your originals are never stored — only the extracted content, on this device.
- **Limits (enforced client- and server-side).** 5 attachments per message; images ≤ 1.5 MB decoded each after re-encode; ≤ 3 scanned-PDF OCR pages; ≤ 200 PDF pages are read at most (pages beyond that are never loaded and the document is marked as truncated); ≤ 8000 extracted characters per document, ≤ 12000 per message; the text-only `/chat` request keeps its 64 KiB limit while attachment requests are accepted up to a bounded 8 MiB and rejected beyond it. MIME type and file signature (magic bytes) are validated on both sides; remote image URLs are never fetched; only base64 data is accepted.
- **Cost.** Workers AI's free daily allocation (10,000 Neurons) only — no Workers Paid upgrade, no prepaid AI Gateway credits, no external paid API. When the allocation is exhausted the Worker returns a clear "resets at 00:00 UTC" message and processing stops until it resets; there are no automatic retries that would consume extra quota. The FREE chat model configuration is unchanged; PRO and MAX stay locked.
- A message without text stays local and is explained instead of being sent — attachments travel with a question ("What is in this image?", "Summarise this PDF").

### Conversation context

The Worker is stateless, so every request carries the conversation so far. `src/js/history.js` builds that list from the open conversation only: earlier `user`/`assistant` turns, then the newest message exactly once. Local notices, empty assistant placeholders and blank messages are dropped; turns with only attachment metadata are dropped, while turns carrying extracted attachment content keep it (bounded) so follow-ups retain context. The list never starts with an assistant turn, and it is bounded to 16 messages / 4000 characters each / 12000 characters in total (`LIMITS` in `src/js/config.js`). The Worker re-validates the same rules and forwards the history to the FREE model. The open conversation is remembered (`activeConversation` in local storage) so a reload or an Android WebView restart continues the same chat instead of silently starting a new one; "New chat" clears it. Regression tests live in `tests/unit/context.test.js`, `tests/unit/features.test.js` and `backend/test/index.test.js`.

## Branding

The in-app mark is the supplied logo, `src/assets/logo/nyx-mark.png` (square PNG, 512 x 512, displayed at its original proportions). The login screen, sidebar brand, welcome screen, About screen, favicon and chat avatar all reference this single asset; `index.html` and `src/js/chat.js` are the only places that name it. The PWA icons (`src/assets/icons/`) and the Android icon sources (`resources/`) are derived from it by rescaling and centring only — never cropping, recolouring or redrawing — with `npm i --no-save sharp && node scripts/generate-icons.mjs`. The supplied file is an opaque square, so the adaptive foreground layer is the logo centred on a transparent canvas rather than a cut-out mark. The Android launcher icon is generated by `scripts/android-icons.mjs` (see above); it also uses this logo and only ever rescales and centres it.

## Git workflow

Work on a feature branch based on `develop` and open a pull request targeting `develop`; never modify `main`. Do not commit `node_modules/`, `www/`, credentials, or Android build output.

### Termux

Install `git` and a compatible `nodejs-lts`, clone the repository, check out a feature branch based on `develop`, then run the development commands above. Open `http://localhost:5173` on the same device. Building an Android APK requires an Android SDK and Gradle environment; the web development server does not build an APK.
