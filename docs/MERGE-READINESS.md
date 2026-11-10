# Merge-readiness review — PR #13

Reviewed commit `7cff18e` (branch `arena/afba752c-nyx-ai`, base `develop` @ `2a3fad1`).
Every statement below was checked against the working tree or produced by running code; nothing is
recalled from memory. No merge, no deploy, no changes to `develop` or `main`, no new PR.

---

## 1. elapsedMs is committed and pushed

| | |
| --- | --- |
| Commit | `7cff18e` — *docs(investigation): analyse the first real production capture; add elapsedMs* |
| Local `HEAD` | `7cff18ec0226917e6d6287e58c75f7da35e0d75d` |
| Remote branch head | `7cff18ec0226917e6d6287e58c75f7da35e0d75d` — **identical** |
| Working tree | clean |
| PR #13 | open, **draft**, base `develop`, mergeable |

## 2. The complete diff

13 files, +2751 / −102. Six commits.

| File | Change | Risk |
| --- | --- | --- |
| `backend/src/attachments.js` | indexed base64 decode; `classifyVisionFailure`; `logVisionFailure`; `visionFailureResponse`; provider-response validation; validation categories | medium — new logic on an error path |
| `backend/src/index.js` | vision-loop error handling; validation diagnostic | medium — error path only |
| `src/js/attachments.js` | PDF byte-snapshot arena; diagnostics sink | **low-medium — the only functional fix** |
| `src/js/transport.js` | failure classification; bounded relay of Worker messages | low |
| `src/js/chat.js` | `userFacing` gating of error text | low |
| `src/js/app.js` | wires the diagnostics sink | trivial |
| 4 test files, 3 docs | coverage and reports | none at runtime |

**Backend behaviour changes, exhaustively:**
1. base64 decode: `Uint8Array.from(binary, cb)` → indexed loop. Output verified byte-identical.
2. A rejected attachment now emits one log record *and returns the same error and status as before*.
3. A failed vision call now emits one sanitized record and maps the category to a specific
   status/message instead of always 502 + one fixed string.
4. `analyzeImage` validates the provider response shape (`AI_BAD_RESPONSE`) instead of silently
   treating a missing `answer` as an empty one (`AI_EMPTY`).

Nothing else in the Worker changed: no auth, no origins, no rate limits, no body caps, no model ids,
no prompt construction, no conversation handling.

## 3. Text-only chat is unaffected — verified by execution

Old (`2a3fad1`) and new (`7cff18e`) Worker code were loaded side by side and driven with the same six
requests; responses compared byte for byte:

| Scenario | Deployed | PR #13 | Identical |
| --- | --- | --- | --- |
| text-only success | 200 `{"reply":"Hi there"}` | 200 `{"reply":"Hi there"}` | yes |
| text-only with history | 200 `{"reply":"ok"}` | 200 `{"reply":"ok"}` | yes |
| text-only, empty model reply | 502 | 502 | yes |
| text-only, provider throws | 503 | 503 | yes |
| no messages | 400 | 400 | yes |
| unsupported tier | 403 | 403 | yes |

**6/6 identical.** No file on the text-only path was modified: `auth.js`, `history.js`, `models.js`,
`settings.js`, `router.js`, `ui.js`, `conversation.js` are all untouched by the diff, and the
text-only 64 KiB body limit and its gate are unchanged.

## 4. Image and PDF handling is intact — verified by execution

Seven attachment shapes through the PR #13 Worker with a stubbed provider:

| Shape | HTTP | Vision calls | Results |
| --- | --- | --- | --- |
| image only | 200 | 1 | 1 |
| image + question | 200 | 1 | 1 |
| two images | 200 | 2 | 2 |
| text PDF document | 200 | 0 (correct — sent as text) | — |
| scanned PDF (OCR page) | 200 | 1 | 1 |
| 2 OCR pages | 200 | 2 | 2 |
| OCR + image + document | 200 | 2 | 2 |

Correct call counts, one analysis per image, documents never sent to the vision model.
The PDF fix itself is covered by 33 tests in `tests/unit/pdf-buffer.test.js`, which assert the copy
count (2 for a text PDF, 3 for a scanned one, never per page) and that the snapshot is never detached.

## 5. Tests and CI on `7cff18e`

| Check | Result |
| --- | --- |
| `npm test` (frontend + static) | **218 / 218 passed** |
| `cd backend && npm test` | **97 / 97 passed** |
| `npm run build` | Built `www/` |
| `wrangler deploy --dry-run` | Compiled, 28.92 KiB |
| `node scripts/android-icons.mjs --check` | 22/22 files |
| `git diff --check` | clean |
| CI `e2e` | **pass** 2m3s (run 42772848433, headSha `7cff18e`) |
| CI `apk` | **pass** 2m15s (run 42772848318) |

## 6. Diagnostic logging cannot expose user data — tested adversarially

**Backend.** The record is an allowlist, not a pass-through. `category` must match
`^[A-Z][A-Z0-9_]{0,40}$` or the record is **dropped**; `stage` must match a lower-case dotted token
or falls back to `vision`; `status` must be an integer 100–599; `providerCode` a 4-digit integer;
`elapsedMs` coarsened to 100 ms. Provider error text is never logged, never stored on the error
object and never returned.

Adversarial test: a provider error embedding a data URI, a file name, a prompt and a JWT-shaped
string yields exactly one clean record; a caller passing hostile values directly into the record
fields gets the record dropped. A separate test asserts the record's key set is exactly
`{category, elapsedMs, event, providerCode, stage, status}`.

**Frontend.** `createAttachmentDiagnostics` records `stage`, `category` and numeric `status`/`kind`
only — never the token, body, attachments, base64 or file names. The only pre-existing raw log
(`console.error` with a file-processing error message) was **removed** in this PR.

**Verified by the repo's own hygiene test**, which scans for secrets: it caught a JWT-shaped fixture I
had written and I rebuilt it at runtime rather than weakening the check.

### RESOLVED — the relay gate is now an allowlist

_This section described the earlier pattern-based gate as a residual risk. It has since been
replaced; the original text is kept below for the record._

The relay no longer pattern-matches. `messageForFailure()` uses the server's `error` string **only
as a lookup key** into `KNOWN_FAILURE_MESSAGES` — an exact, whole-string match against sentences the
app ships. Anything else, including every provider string, falls back to a fixed sentence. This
cannot be talked around, and it fails closed: a new Worker message shows the generic sentence until
it is added deliberately.

Adversarial tests (data URI, base64 blob, filename, prompt, JWT, provider codes, every HTTP status)
were run against the **old** gate first and **failed 3 of them**, confirming the exposure was real
rather than theoretical. Reverting the allowlist to a keyword relay fails those same 3 tests.

A derived-list test reads the Worker's own source and fails if any of its fixed `error` strings is
missing from the frontend allowlist, so the two cannot drift apart silently.

### Original (superseded) note

`transport.js` relays a Worker `error` string to the user if it is ≤200 chars, contains no
`\n\r\t<>{}[]`$\\`, **and** matches a keyword list (`image`, `file`, `request`, …). I probed this
gate with provider-shaped strings and found that strings like
`AiError: 5004 Input image is invalid: data:image/jpeg;base64,…` and
`Invalid token: eyJ… for request` **would** pass it.

That is currently safe **because** every `error` body the Worker can emit is a fixed literal —
verified: 30+ distinct strings, all literals, none derived from input or provider text; the only
interpolations are two module constants (`MAX_ATTACHMENTS`, `MAX_OCR_PAGES`). But the safety is
conditional on backend discipline rather than on the gate itself. Recorded as a risk below.

## 7. What changes in production if you merge

Merging to `develop` **auto-deploys the Worker**: `.github/workflows/cloudflare-deploy.yml` triggers
on push to `develop` with `paths: backend/**`. The frontend only changes when a new APK is built.

**Worker (immediate, on merge):**
- failed vision calls log one `nyx.vision.failed` JSON line with stage/category/status/code/elapsedMs
  instead of the fixed string `Workers AI vision request failed.`;
- rejected attachments (decode, magic bytes, size) now log too — previously silent;
- users get a **specific** message and status for many causes instead of one generic 502:
  plan gate / model unavailable → 503, too large → 413, invalid image → 415, capacity/timeout → 503
  retryable, malformed response → its own 502 text, quota → unchanged 429;
- base64 decode is ~35× faster (86 ms → 2.4 ms on a 1.4 MB image);
- a 200 response with no `answer` is now `AI_BAD_RESPONSE` rather than `AI_EMPTY`.

**App (next APK build):** specific attachment errors reach the user; PDF extraction no longer fails
with the detached-ArrayBuffer error on scanned/short-text PDFs; the raw `console.error` of file
error messages is gone.

**Unchanged:** model ids, free-plan usage, request shapes, prompts, auth, rate limits, body caps,
text-only responses (proved identical above).

## 8. Diagnostics vs. actual fixes — the distinction that matters

| | What it does | Status |
| --- | --- | --- |
| **PDF detached-ArrayBuffer** | **A real fix.** One snapshot per document, one copy per load; PDF.js may detach its own copy without breaking the OCR pass. | Fixed, with 33 tests |
| base64 decode cost | **A real optimisation** (86 ms → 2.4 ms). Measured, but **not** the production cause — your capture falsified CPU exhaustion. | Correct to ship, honestly labelled |
| `nyx.vision.failed` record | **Diagnostics only.** Observes the failure; changes nothing about it. | Ready |
| `visionFailureResponse` | **Diagnostics/user experience.** Turns one opaque 502 into specific causes; still fails. | Ready |
| response-shape validation | **Diagnostics.** Reclassifies; does not make the model succeed. | Ready |

### The bottom line for your decision

**Your image failure is NOT fixed by this PR.** It is *made observable*. Your capture proved the
request reaches the vision call and fails inside it — the PR does not touch that code path's outcome,
only what is reported about it. After merge and deploy, the next failing image produces the exact
category and code, which is what a fix will be built from.

The PDF failure **is** fixed.

---

## Deployment safety gate

`.github/workflows/cloudflare-deploy.yml` now has two jobs:

- **`verify`** — reuses `cloudflare-check.yml` unchanged via `workflow_call` (frontend tests, build,
  backend tests, `wrangler deploy --dry-run`);
- **`deploy`** — declares `needs: verify`, so it cannot start unless verification succeeded;
- **both jobs pin `github.sha`.** `cloudflare-check.yml` previously checked out `ref: develop`, a
  race: it read whatever the branch pointed at when the checkout ran, not the commit the run was
  raised for. Inside a reusable workflow the `github` context is the caller's, so `github.sha`
  resolves to the caller's triggering commit — the same value `deploy` uses. Verified and shipped
  commits are now provably identical.

**First merge:** the gate is active immediately. GitHub resolves local `./` references from the
caller's own commit, not the default branch, so no bootstrap step or default-branch workaround is
needed. (An earlier revision of this document wrongly claimed otherwise.)

`cloudflare-check.yml` gained only a `workflow_call:` trigger — no steps added, removed or weakened;
it still runs on every push to `develop` exactly as before. Nine tests in
`tests/unit/deploy-gate.test.js` pin the gate. Removing `needs: verify`, reverting a checkout to
`ref: develop`, or hardcoding a SHA each fails at least one of them.

## Remaining risks

1. **The PR does not fix the reported image failure.** Merging will not restore image analysis. If
   that expectation is not explicit, this could read as a failed fix.
2. **Merging deploys immediately and automatically** — there is still no manual approval step, but
   the deploy job now cannot run until the reuse-gate workflow has passed. Merging is still
   deploying, now with a test gate in front of it that runs against the same pinned commit.
3. **One production deploy of unverified-in-production error paths.** The new mappings
   (415/413/503) have unit coverage but have never served real traffic. The blast radius is failures
   only — a successful request is unaffected — but a mistake here changes what users see when things
   already went wrong.
4. **Frontend/backend skew.** The APK and the Worker ship separately. The relay gate in
   `transport.js` expects the new Worker messages; the new Worker's messages are all
   backward-compatible (old frontend shows its generic text), so skew is safe in both directions, but
   the improved messages only appear in a new APK build.
5. ~~The relay gate is keyword-fragile~~ — **resolved**: it is now a closed allowlist, with
   adversarial and anti-drift tests. Residual: a new Worker message will show the generic sentence
   until it is added to `KNOWN_FAILURE_MESSAGES` (fails closed, and the derivation test flags it).
6. **`AI_EMPTY` / `AI_BAD_RESPONSE` can still mean a legitimately blank answer** for a blank image.
   Not distinguishable from a fault without seeing the image; not claimed to be.
7. **Draft status.** The PR is still a draft; it cannot be merged until marked ready.
8. **Not verified in this environment:** Android WebView, a real deploy, live Workers AI inference.
   CI's APK and Playwright suites passed, but neither exercises the Worker against the real model.
