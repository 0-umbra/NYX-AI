# Image attachment failure after PR #14 — 2026-11-12

## Scope and evidence boundary

Inspected `develop` at `fd66f2961917218eabbfcbd65d6526d0130d16ca` (the PR #14 merge) and the
attachment history through PRs #12–#14. Work is on the supplied Arena feature branch based on that
commit. No merge, deployment, production inference, or credential access was performed.

The new report supplies `POST /chat → 502`, wall time **2959 ms**, request length **154605 bytes**,
and Worker version `ff1b5cfd-dce9-4c96-9d61-3cd41734352b`. GitHub records a successful deployment of
`fd66f29` after PR #14. The deployment log download redirects outside this sandbox's allowed hosts,
so the version ID was not independently matched to that run.

**Important:** the supplied summary does not include the new `nyx.vision.failed` record, the upstream
HTTP headers, or the upstream body. It therefore cannot identify which production branch failed.
This investigation confirms and fixes a reproducible runtime-boundary defect; it does **not** claim
that the missing production evidence proves that defect caused this particular request.

## Complete image path

1. `src/js/chat.js` validates the selected file; `downscaleImageFile()` in `src/js/attachments.js`
   decodes it on-device, bounds the longest edge to 1024 px, and re-encodes it under the byte budget.
2. `buildSendAttachments()` sends `{ name, kind: "image", mime, data }`, where `data` is a base64 data
   URI. Scanned-PDF pages use the same image path with `ocr: true`. Original files are not uploaded.
3. `src/js/transport.js` sends authenticated JSON to `/chat`. Its exact-message allowlist displays the
   Worker's “couldn’t read that image” sentence; it does not invent image analyses.
4. `backend/src/index.js` authenticates, rate-limits, reads the bounded body, and calls
   `validateAttachments()` (base64, MIME, magic bytes, and size checks). Validation failures are
   400/413, not this 502. The reported 154605-byte body is well below the 8 MiB attachment cap.
5. `analyzeImage()` calls the unchanged `@cf/moondream/moondream3.1-9B-A2B` model with `task: "query"`,
   the data URI, `question`, `reasoning: false`, `max_tokens: 640`, and `stream: false`.
6. The validated `answer` becomes attachment context for the unchanged FREE chat model and is returned
   in `attachmentResults`. Vision failures return before chat inference. `nyx.chat.timing` is emitted
   only for requests that reach chat inference, so its absence on a vision failure is expected.

## Confirmed defect (reproduced, not inferred from wall time)

Cloudflare's current model schema specifies a base64 data URI image and an `answer` string for the
query task; `stream` defaults to **false**. PR #14's claim that the model defaults to streaming is not
supported by the current schema. Keeping `stream: false` explicit is still correct.

References:

- Model page: https://developers.cloudflare.com/workers-ai/models/moondream3.1-9B-A2B/
- Input schema: https://developers.cloudflare.com/workers-ai/models/moondream3.1-9B-A2B/schema-input.json
- Output schema: https://developers.cloudflare.com/workers-ai/models/moondream3.1-9B-A2B/schema-output.json
- Pinned runtime source: https://github.com/cloudflare/workerd/blob/v1.20261103.1/src/cloudflare/internal/ai-api.ts

The Wrangler-installed `workerd 1.20261103.1` AI binding parses a successful response **only** when
`res.headers.get("content-type") === "application/json"`. Otherwise it returns `res.body`. A valid,
non-streaming JSON response labeled `application/json; charset=utf-8` therefore becomes a
`ReadableStream`, despite `stream: false`.

PR #14 treated every such stream as malformed, cancelled it without reading it, and threw
`AI_BAD_RESPONSE`. `visionFailureResponse()` maps that category to the reported 502 sentence. The old
tests missed this because their successful provider mocks returned already-parsed objects.

### Red/green reproduction

`backend/test/image-runtime.test.js` runs the actual `cloudflare-internal:ai-api` wrapped binding in
the pinned local `workerd` binary against a local HTTP mock. No account or remote inference is used.

| Upstream response | Before fix | After fix |
| --- | --- | --- |
| Valid `{ answer, finish_reason, metrics, ... }`, `Content-Type: application/json` | pass | pass |
| Same valid JSON, `Content-Type: application/json; charset=utf-8` | `VisionError: unexpected streaming response` / `AI_BAD_RESPONSE` | pass |
| Full Worker route with the same JSON body as a stream | HTTP 502, reported image-read sentence | HTTP 200 with `attachmentResults` |

The 2959 ms wall time is not used as proof: it includes non-inference work and is not `visionMs`.

## Smallest reliable fix

Only `backend/src/attachments.js` changes production behavior:

- Normalize a returned body stream by reading and parsing its JSON instead of rejecting it outright.
- Cap the response at 64 KiB and include body consumption in the existing 20-second timeout.
- Cancel a stalled reader on timeout and a stream that arrives after timeout; release readers and
  swallow cleanup errors without replacing the original failure.
- Keep strict `answer` validation and the existing `AI_BAD_RESPONSE` / `AI_EMPTY` distinction. SSE,
  HTML, malformed JSON, non-string answers, and blank answers are not accepted as image analyses.
- Preserve provider-error classification and sanitized diagnostics. Response fragments and parse
  error text are never logged or returned.

The vision model, chat model, request inputs, frontend, limits, auth, and deployment configuration are
unchanged. No dependency or paid service was added.

## Verification

| Check | Result |
| --- | --- |
| Backend `npm test` | **114 passed**, 0 failed |
| Targeted image + real-runtime regressions | **54 passed**, 0 failed |
| Frontend `npm test` after clean `npm ci` | **218 passed**, 0 failed |
| Frontend `npm run build` | passed |
| Browser suite, including visual audit | **46 passed**, 0 failed (Playwright 1.56.1, locally supplied Chromium 153) |
| `wrangler deploy --dry-run` | passed; 33.44 KiB / 9.38 KiB gzip; no deployment |
| Android launcher icon check | **22 files verified** |
| `git diff --check` | clean |
| Package/lockfile changes | none |

The optional browser test dependencies were installed without saving or changing lockfiles; the final
frontend suite and build ran after restoring the lockfile install with `npm ci`.

## Remaining uncertainty / review gate

Live Moondream inference and the production upstream Content-Type remain **unverified**. The fix is
supported by the real-runtime reproduction, but production success must not be claimed until the
reviewer deploys it and tests a real image. If it still fails, capture the sanitized
`nyx.vision.failed` fields (`stage`, `category`, `status`, `providerCode`, `elapsedMs`) for that request.
Do not share authorization tokens, image data, prompts, or raw provider errors.

`AI_BAD_RESPONSE` and `AI_EMPTY` both map to the same user-facing sentence, so HTTP 502 plus wall time
alone cannot distinguish them. A provider rejection unrelated to body normalization would also need
its own evidence; this PR does not silently relabel such failures as success.
