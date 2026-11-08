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

## Data and behaviour

Conversations, titles and pins are stored locally, not synced or partitioned by account. Signing out does not erase them; anyone using this device and signing in can see them. Clearing app data deletes local history. Attachments currently save metadata only and are not sent to the model; voice and memory are previews. Worker replies are complete JSON responses: the frontend progressively reveals the returned text, not genuine streaming. Stopping a reveal retains only the text shown so far. PRO and MAX cannot be selected or sent to the Worker.

## Branding

The existing in-app mark is `src/assets/logo/nyx-mark.svg`; HTML and the chat avatar reference this single asset. Replace it at that path when the new logo is ready. PWA icons under `src/assets/icons/` and Android icon sources under `resources/` are separate assets and are intentionally unchanged.

## Git workflow

Work on a feature branch based on `develop` and open a pull request targeting `develop`; never modify `main`. Do not commit `node_modules/`, `www/`, credentials, or Android build output.

### Termux

Install `git` and a compatible `nodejs-lts`, clone the repository, check out a feature branch based on `develop`, then run the development commands above. Open `http://localhost:5173` on the same device. Building an Android APK requires an Android SDK and Gradle environment; the web development server does not build an APK.
