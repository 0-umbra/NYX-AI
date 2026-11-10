# Production attachment failure — investigation (2026-11-10)

Scope: every attachment request in the field fails with
`NYX AI couldn't analyse an attached image. Please try again later.`, while text-only chat works.
APK under test: `.github/workflows/android-debug.yml` run **42750867077**, built from
`8156267` on branch `arena/afba752c-nyx-ai` (PR #13).

This document separates **confirmed facts** from **hypotheses** and states explicitly what could not
be inspected from the development environment.

---

## 0. What I could not inspect (evidence that is missing)

| Evidence | Status |
| --- | --- |
| Production Worker source (`wrangler tail`, dashboard, deployments) | **NOT INSPECTED.** No Cloudflare integration is available in this environment (the connector reports `unsupported`), and no Cloudflare credentials are present. |
| Workers AI call outcome for the failing request | **NOT OBSERVED.** No provider response, status or error code was captured. |
| Production Worker logs / invocation outcome (`exceededCpu`, `exceptions`, …) | **NOT AVAILABLE.** |
| The user's actual files | Not available; all fixtures below are locally generated. |
| Live inference against Moondream | **NOT PERFORMED.** Outbound access to the Worker and to Workers AI is blocked here. |

Everything below is therefore derived from (a) the code, and (b) local execution of that exact code
with stubbed provider/token inputs. That is enough to prove **which stages can produce the observed
string**, and to narrow the cause sharply. It is **not** enough to name the provider's error code.

---

## 1. Confirmed facts

### F1 — The message is emitted by exactly one place, and it is a Worker response

```
backend/src/attachments.js:300  visionFailureResponse(default)
  → 502 { error: "NYX AI couldn't analyse an attached image. Please try again later." }
```

It is the catch-all for any vision-model failure that is not identifiable as quota. The frontend
bundle contains **zero** occurrences of that string, so the APK cannot have produced it locally.

### F2 — The APK under test predates the backend changes in this PR

| | |
| --- | --- |
| APK run 42750867077 `headSha` | `8156267` (frontend + backend changes) |
| An APK embeds only the frontend | backend changes in `8156267` ship to the device **not at all** |
| `develop` HEAD | `2a3fad1` (the PR #12 merge) — **0 commits since** |
| Last `Deploy NYX AI Worker` run | **42742813987**, triggered by the `develop` push of `2a3fad1`, 2026-11-10T02:26:48Z, success |
| Latest deploy run of any kind | that same run — nothing deployed our branch |

**Therefore production is running the PR #12 backend.** The refined error mapping and the indexed
base64 decoder exist only in this PR and are not active. This also means nothing in this PR can
have caused the current failure.

### F3 — The plan gate is not the cause

Official Cloudflare changelog (2026-07-28, *Select models now require the Workers Paid plan*):
paid-only models are `@cf/moonshotai/kimi-k2.6`, `@cf/moonshotai/kimi-k2.7-code` and
`@cf/zai-org/glm-5.2`. `@cf/zai-org/glm-4.7-flash` (the app's FREE chat model) is **explicitly
still free**, and Moondream is on no paid-only list. Text-only chat succeeding corroborates the free
plan. *(An earlier search result showing glm-4.7-flash in a paid list was a misread of a different
changelog entry; the primary source above is authoritative.)*

### F4 — Request format and parsing are correct

Running the PR #13 Worker with a faithful stubbed `env.AI`:

| Case | Result |
| --- | --- |
| 1 image, documented `{ answer }` response | 200 |
| 3 images | 200 |
| 1 scanned-PDF OCR page | 200 |
| 2 OCR pages + 1 image | 200 |
| document-only (text PDF) | 200, vision never called |
| provider throws | 502 `…couldn't analyse an attached image…` |
| **empty answer** (`answer: "  "`) | **502** `…couldn't analyse an attached image…` |
| **no `answer` field** | **502** `…couldn't analyse an attached image…` |

So the payload shape (`task`, `image` data URI, `question`, `reasoning`, `max_tokens`) and the
documented response parsing work. The observed message is produced by (a) any provider error, or
(b) a provider response whose `answer` is absent/not a string/blank.

### F5 — Text-only chat does not touch the failing stage

`/chat` with no attachments skips `validateAttachments` image work and the whole vision loop. That
is exactly why chat keeps working while every attachment fails: **the failure is confined to the
vision stage** (and, for scanned PDFs, to the OCR pages that feed it).

### F6 — For PDFs, this message can only come from OCR pages

A PDF is never sent to the vision model as a document. `buildSendAttachments()` expands only a
scanned PDF's rendered pages into `kind: "image", ocr: true` entries. So a PDF producing this exact
message implies its OCR pages were rendered and submitted — i.e. the vision stage failed, not PDF
parsing.

### F7 — The frontend cannot produce this message from a PDF parse failure

Two separate failures exist in the shipped frontend, and neither yields the reported string:

Ran against `develop` @ `2a3fad1` in jsdom (production `chat.js` + `attachments.js`):

| Fixture | Chip status (composer) | Conversation notice | Request sent? |
| --- | --- | --- | --- |
| Long text PDF (> 25 chars) | `Text extracted · 1 page` | none | **yes — document** |
| Scanned PDF (no text layer) | `Cannot perform Construct on a detached ArrayBuffer` | none | **no** |
| Short-text PDF (≤ 25 chars) | `Cannot perform Construct on a detached ArrayBuffer` | none | **no** |

Pre-PR, a PDF-extraction failure is a **composer chip error** and blocks the send; it never reaches
the transport, so it cannot yield a 502 body. (This is also the confirmation of the PR's PDF root
cause: long-text PDFs work, scanned and short-text PDFs throw.)

### F8 — REFUTED (kept for the record): the request-size / CPU cost of the image path

> **Status: refuted by production evidence.** This was the leading hypothesis before the first real
> capture. The 2026-11-10 log shows the Worker emitting its own error line and returning a 502, which
> a CPU-killed isolate cannot do. The measurements below are still valid — the base64 decode really
> did cost 56–102 ms, and the fix that followed is real — but **CPU exhaustion is not the cause of
> the image failures.** See the addendum at the end of this document.

Measured locally on the **production** `validateAttachments`/`decodeDataUriImage` code
(Node 22, warm, per request, JSON body already built):

| Payload | Serialized request | `TextDecoder` | `JSON.parse` | `validateAttachments` (of which `Uint8Array.from(cb)` base64 decode) | Total |
| --- | --- | --- | --- | --- | --- |
| 1.4 MB JPEG | 1.82 MiB | 0.94 ms | 1.23 ms | **104.96 ms** (**86.27 ms**) | **≈102 ms** |
| 900 KB PNG | 1.17 MiB | 0.51 ms | 0.75 ms | **51.70 ms** (**49.43 ms**) | **≈56 ms** |
| 8,000-char PDF text document | ≈8 KB | — | — | 0.02 ms | **0.02 ms** |

Request-size limits are **not** the cause: both payloads are far below the 8 MiB attachment cap and
below Cloudflare's 100 MB body limit. But Workers Free documents a **10 ms per-request CPU limit**,
and the base64 decode alone consumes 5–9× that before any AI call is made.

Two other facts point the same way:

- `backend/wrangler.jsonc` has **no `limits.cpu_ms`** block (so the platform default applies) and
  `compatibility_date: "2026-11-03"`.
- Cloudflare documented (2026-09-17) that Workers AI is GA with revised rate limits, and the
  Workers Free CPU budget moved from 10 ms of *CPU* to **10 ms per invocation** with resets — the
  *actual* free allowance is less deterministic than the quoted figure.

---

## 2. Hypotheses (ranked, with what would confirm each)

### H1 — REFUTED by the 2026-11-10 capture — the base64 decode + payload handling exceeds the Workers Free CPU budget

> **Do not read this as the cause.** Production logs show `Workers AI vision request failed.` — a
> line this code reaches only *after* base64 decoding and validation succeed — followed by a 502.
> A CPU-killed Worker is terminated and cannot log and respond. The reasoning below is retained only
> to show what was believed before evidence arrived.

*Why it fits:* the decode cost is 56–102 ms against a documented 10 ms budget, and it scales with
image size; text-only requests do none of this work (0.02 ms) which is why chat is unaffected. A CPU
or memory kill returns Cloudflare's own error page, and the PR #12 frontend maps any non-OK,
non-quota response to… the very message observed. It also explains **both** attachment types, since
scanned-PDF OCR pages travel through the same image path.

*Status: the capture showed the Worker's own `console.error("Workers AI vision request failed.")`
line, so the request **did** reach the vision call. H1 is out. What remains unknown is *which*
provider failure it was — the deployed code cannot distinguish them.

### H2 — CONFIRMED as the failing stage, cause still unknown — the provider call fails, and PR #12 collapses every cause into one message

`analyzeImage` in production throws `AI_FAILED` for *any* non-quota error, and the route maps
`AI_FAILED` to this string. Candidate provider causes that the code cannot currently distinguish:
image dimensions/decoded size rejected by the model, a transient `3040` out-of-capacity (now
returned as 429 since GA), a timeout shorter than the model needs, or the model returning a shape
without `answer` (documented as `answer` for `task: "query"`, but unverified live).

*Confirm with:* the same tail — a `Console` line `Workers AI vision request failed.` proves H2 and
rules out H1; the provider status/code is what PR #13's diagnostics were built to record.

### H3 (unlikely) — model availability

Moondream is a GA Workers AI model and is not on the paid-only list (F3). No evidence of
unavailability was found. Cannot be fully excluded without a live call.

---

## 3. Stage-by-stage verdict

| Stage | Image | PDF | Verdict |
| --- | --- | --- | --- |
| Pick / MIME / magic-byte checks (device) | ok | ok | not implicated |
| Decode + downscale + re-encode (device) | ok when the image attaches | n/a | not implicated (the failure is after send) |
| PDF.js text extraction (device) | n/a | ok for long-text PDFs (F7) | **scanned/short-text PDFs fail here pre-fix** — and that is this PR's PDF fix |
| OCR page rendering (device) | n/a | only for scanned PDFs | feeds the image path |
| Serialize + transport | ok | ok | not implicated |
| Firebase auth / rate limit | ok (chat works) | ok | not implicated |
| Worker body read + JSON parse | 1–2 ms | 0.02 ms | not implicated |
| **`validateAttachments` → base64 decode** | **50–86 ms** | — | **H1** |
| **Vision model call + response parse** | reached only if the above survives | — | **H2** |
| Frontend error mapping | maps everything to one message | — | why the cause is invisible; **fixed in PR #13** |

**The failure is backend/platform-side, not frontend.** The frontend faithfully displays whatever
the Worker returns.

---

## 4. Minimal recommended fix

1. **Land PR #13's backend** (the reason it exists):
   - indexed base64 decode — measured 86.27 ms → 2.39 ms (1.4 MB) and 49.43 ms → 1.46 ms (900 KB),
     byte-identical output, so every size/magic-byte/MIME check is unchanged;
   - `classifyVisionFailure` + `visionFailureResponse` — the vision stage stops reporting one opaque
     502 and logs a sanitized `{stage, category, status, providerCode}` record;
   - provider-response validation, so an empty/malformed `answer` is distinguished from a provider
     error.
2. **Deploy it** (`develop` merge → the existing `cloudflare-deploy.yml`) and read `wrangler tail`
   during one image request. That single observation decides H1 vs H2 and is the only missing
   evidence.
3. **No paid step is required.** If H1 is confirmed, the CPU cost is reduced by the decode fix
   alone; if H2 is confirmed, the recorded category names the exact provider cause and the smallest
   fix follows from it (e.g. a token/timeout adjustment), still on the free allocation.

Do **not** change the model id, the free plan, or any limit on the basis of the current evidence.

---

## 5. Tests this investigation added to the case for PR #13

Existing suites (`200` frontend, `87` backend) already cover the detachment regression, the base64
decode cost guard, provider-error classification, malformed/empty responses, timeouts and the
user-facing mapping. What the field report adds — and what is **not** yet covered — is an
end-to-end assertion that a production-shaped image request stays within a CPU budget, and a test
that the generic 502 body is never produced for a *classifiable* cause. Both are recorded below as
follow-up work rather than silently claimed as done.

---

## 6. Summary

- **Exact failing stage:** the Worker's image path — base64 validation/decoding (H1) or the
  vision-model call and its response parsing (H2). Both are in the Worker; neither exists in
  text-only chat.
- **Backend, not frontend.** The message is a Worker 502 body; the APK contains no such string.
- **Deployment:** production runs PR #12 (`2a3fad1`), *not* this branch. This PR cannot have caused
  the regression, and its fixes are not active yet.
- **Model availability:** no evidence of a problem; the plan gate is ruled out by primary sources.
- **Not established:** the provider's actual error code. That requires the production logs this
  environment cannot reach.

---

# Addendum — analysis of the first real production capture (2026-11-10 12:29 IST)

The following was captured by the reporter from Cloudflare Dashboard → Workers & Pages →
nyx-ai-backend → Observability → Live. It is the first production evidence in this investigation and
it is recorded verbatim.

```
2026-11-10 12:29:24.910 IST  error  Workers AI vision request failed.
2026-11-10 12:29:24.910 IST  error  POST https://nyx-ai-backend.mehrablone100-8ee.workers.dev/chat
2026-11-10 12:29:23.714 IST  info   OPTIONS https://nyx-ai-backend.mehrablone100-8ee.workers.dev/chat
```

## What this establishes

**1. The request reached the Worker, authenticated, parsed, and entered the vision loop.**
`Workers AI vision request failed.` is emitted at exactly one place in the deployed code
(`2a3fad1:backend/src/index.js:338`), inside the `catch` around `analyzeImage`. Reaching that line
requires all of the following to have already succeeded: CORS preflight, Firebase JWT verification,
the rate limiter, reading the body under the size cap, `JSON.parse`, `validateAttachments` (including
base64 decoding and the magic-byte check), the model-tier check, conversation building, and the
`kind !== "image"` filter. So none of those is the cause.

**2. The failure was not quota, and not a rate limit.** Both `AI_QUOTA` and the limiter return
*before* that line, and neither logs it.

**3. CPU exhaustion is not the explanation — and this corrects the earlier hypothesis.** A Worker
killed for exceeding its CPU budget cannot emit a console entry and then return a 502 body: the
execution is terminated. Observing a deliberate `console.error` and a completed request at the same
millisecond falsifies H1 as previously stated. The 50–86 ms decode measurement was real, but it is
**not what is failing here**. The base64 decoding completed successfully — that is precisely why the
request reached the vision call.

**4. The failing stage is `ai.run(VISION_MODEL, …)` or the parsing of its result.**

**5. The response is a 502 with an empty 24 ms round trip,** which rules out the 20 s vision timeout
as the cause of this particular failure.

## What remains unknown

The deployed code cannot say *why* the vision call failed. `2a3fad1` maps everything that is not
quota — a missing model, a rejected payload, capacity, a plan gate, a malformed response — onto this
single string. This was verified by executing the deployed request path with a stubbed provider:

| Simulated cause | Deployed log line | Deployed status |
| --- | --- | --- |
| provider throws, no code | `Workers AI vision request failed.` | 502 |
| 5007 no such model | *identical* | 502 |
| 3040 out of capacity | *identical* | 502 |
| 5035 paid plan | *identical* | 502 |
| 5004 invalid data | *identical* | 502 |
| no `answer` field | *identical* | 502 |
| empty `answer` | *identical* | 502 |

Seven distinct causes; one indistinguishable line. **The captured log therefore proves where the
failure is, but not what it is.** Reporting a cause from it would be guesswork.

## The 24 ms gap — suggestive, not proven

`OPTIONS` completed at 23.714; the `POST` and its error share the timestamp 24.910, ≈1.20 s later.
The 502 came back within milliseconds of the vision call failing, apparently in the same millisecond.
A generation attempt by a 9B model takes seconds even for a trivial image. A near-instant failure is
more consistent with an immediate rejection (bad request shape, unsupported or unavailable model)
than with a slow model. **This is an inference from timestamps, not an observation** — the log does
not show when `ai.run` was invoked, only when the request started and when the error was logged.

## Smaller detail worth checking

The client shows `NYX AI couldn't analyse an attached image…`, but the deployed frontend transport
(`2a3fad1:src/js/transport.js:121-127`) maps a non-quota, non-401/429 error to
`The AI service couldn't respond. Please try again.` — it does **not** surface the server's `error`
field. So the exact wording the user sees may indicate a newer frontend build than the deployed
backend, or a different surface (e.g. the attachment chip) than the transport path. This does not
change the Worker-side conclusion (the 502 is still the Worker's), but it should be confirmed before
the fix is judged by the user's screenshot.

## What the PR #13 build reports for the same seven causes

Executed against the current branch rather than asserted from reading the code:

| Simulated cause | PR #13 record | PR #13 HTTP |
| --- | --- | --- |
| provider throws, no code | `vision.image \| AI_FAILED \| code=null` | 502 |
| 5007 no such model | `vision.image \| AI_MODEL_UNAVAILABLE \| code=5007` | 503 |
| 3040 out of capacity | `vision.image \| AI_OUT_OF_CAPACITY \| code=3040` | 503 |
| 5035 paid plan | `vision.image \| AI_PLAN_REQUIRED \| code=5035` | 503 |
| 5004 invalid data | `vision.image \| AI_INVALID_IMAGE_DATA \| code=5004` | 415 |
| no `answer` field | `vision.image \| AI_BAD_RESPONSE \| code=null` | 502 |
| empty `answer` | `vision.image \| AI_EMPTY \| code=null` | 502 |

All seven become distinguishable — so **yes**, the current PR diagnostics can identify the exact
failure after deployment. Two residual gaps were found and closed in the same commit:

- **A rejection inside `ai.run` that exposes no numeric code** (a bare `AiError: …`) still lands on
  `AI_FAILED` with `providerCode: null`. Category alone would not separate "rejected the payload"
  from "crashed". The record now carries `elapsedMs` (coarsened to 100 ms), which distinguishes a
  sub-second rejection from a multi-second generation that ran out of budget.
- **`AI_EMPTY` / `AI_BAD_RESPONSE` can still mean a legitimate blank answer** for a blank image.
  This is not distinguishable from a fault without knowing the image, and is not claimed to be.
