# Capturing one real production attachment failure

Purpose: obtain the actual production failure reason for image and PDF attachments, which the code
alone cannot establish. This is the single missing piece of evidence.

**Everything here is read-only.** `wrangler tail` streams live logs; it changes no configuration, no
deployment, no data. It is safe to run against production.

---

## 0. Which build these instructions are for

The diagnostics described below (`nyx.vision.failed` records with `stage` / `category` / `status` /
`providerCode`) exist on branch `arena/afba752c-nyx-ai` (PR #13). **They are not deployed.**
`develop` is `2a3fad1` and the deployed Worker logs only the fixed string
`Workers AI vision request failed.` — no fields at all.

So there are two possible captures. Start with **A**; it costs nothing and may answer the question
on its own.

| | What you capture | What you learn |
| --- | --- | --- |
| **A. Deployed code now** | `Workers AI vision request failed.` and the invocation outcome | Whether the request reached the vision call at all |
| **B. After PR #13 is deployed** | `nyx.vision.failed` with category + provider code | The exact cause |

You asked for the smallest safe next action: **that is A.** It requires no deployment and no code
merge, and its outcome alone eliminates half the hypotheses.

---

## A. Capture against the currently deployed Worker

Run this **in one Termux session** and leave it open.

```bash
cd ~/NYX-AI/backend          # adjust to wherever the repo lives
npx wrangler login           # only if you have never authenticated on this device
npx wrangler tail nyx-ai-backend --format json --status error
```

Then, **in the app, while the tail is running**, reproduce the failure twice:

1. send a **text-only** message (this is the control — it works);
2. attach **one image** and send;
3. attach **one PDF** and send.

Stop the tail with `Ctrl-C` and keep the output.

### Reading the result — this is the whole point

You are looking for one of four outcomes per failing request:

| You see | Conclusion |
| --- | --- |
| A console line `Workers AI vision request failed.` | The request **reached the vision call**. Decoding, size caps and transport are all fine; the cause is the provider call or its response. |
| **No** console line, and the tail shows the invocation as `exceededCpu` | The Worker was killed **before** it could report — consistent with the base64-decode CPU hypothesis. |
| **No** console line, invocation `exception` | It threw somewhere that does not log. |
| **No** matching invocation at all | The request never reached the Worker — a client-side or transport problem after all. |

If the control (text-only) shows `exceededCpu` too, then CPU applies to everything and the theory
needs revisiting — note that, do not assume.

### One caveat to check on the spot

Filtering with `--status error` uses Wrangler's own judgement of what failed. If you see nothing at
all while the app clearly shows an error, re-run **without** the filter and repeat:

```bash
npx wrangler tail nyx-ai-backend --format json
```

---

## B. Capture with the full diagnostics (only after PR #13 is reviewed and deployed)

Same command; the records look like this:

```json
{"event":"nyx.vision.failed","stage":"vision.image","category":"AI_OUT_OF_CAPACITY","status":429,"providerCode":3040}
```

The schema is fixed and deliberately dull:

| field | meaning |
| --- | --- |
| `stage` | `validation.image` / `validation.document` (rejected before inference), `vision.image`, `vision.ocr_page` |
| `category` | the failure class, from a fixed list (below) |
| `status` | HTTP-like status the provider reported, when it exposes one |
| `providerCode` | Workers AI numeric error code, when it exposes one |

Categories: `AI_QUOTA`, `AI_OUT_OF_CAPACITY`, `AI_PLAN_REQUIRED`, `AI_MODEL_UNAVAILABLE`,
`AI_MODEL_DEPRECATED`, `AI_INVALID_IMAGE_DATA`, `AI_INVALID_BASE64`, `AI_EMPTY_IMAGE`,
`AI_REQUEST_TOO_LARGE`, `AI_RESOURCE_LIMIT`, `AI_TIMEOUT`, `AI_BAD_REQUEST`, `AI_FORBIDDEN`,
`AI_BAD_RESPONSE`, `AI_EMPTY`, `AI_FAILED`.

### Decision table

| Record | Cause | Fix |
| --- | --- | --- |
| `stage=validation.image`, any category | Payload rejected before any inference | Client-side: format, size or encoding |
| `AI_INVALID_BASE64` / `AI_INVALID_IMAGE_DATA` | Decoder or magic-byte check refused it | Client should re-encode before upload |
| `AI_REQUEST_TOO_LARGE` (3006) | Payload over the cap | Lower the client-side re-encode ceiling |
| `AI_QUOTA` (3036) | Daily free allocation spent | Wait for 00:00 UTC; not a bug |
| `AI_OUT_OF_CAPACITY` (3040) | Transient provider capacity | Retry; not a bug |
| `AI_RESOURCE_LIMIT` (1102) | Resource limit hit inside the call | CPU/memory — the decode fix is the lever |
| `AI_TIMEOUT` (3007/3008) | Model slower than the budget | Review `VISION_TIMEOUT_MS` |
| `AI_MODEL_UNAVAILABLE` (5007) / `AI_MODEL_DEPRECATED` (5028) | Model id problem | Re-check the model id |
| `AI_PLAN_REQUIRED` (5035) | Paid-plan gate | Contradicts the current changelog — investigate before changing anything |
| `AI_BAD_RESPONSE` / `AI_EMPTY` | Provider answered in an unexpected shape | Validate the model's `task: "query"` output |
| `AI_FAILED`, `providerCode: null` | Provider failed without exposing a reason | The status field is the only further clue |

---

## What is deliberately **not** logged

Verified by test, not by inspection alone: no image bytes, no base64, no data URI, no PDF text, no
file names, no prompts, no user text, no auth tokens, no provider message text. Only the four fields
above, and each is format-checked (a category must be an upper-case token, `stage` a lower-case
dotted token, `status` 100–599, `providerCode` a 4-digit integer) so a careless future caller cannot
smuggle data through them. A record that fails those checks is dropped rather than logged.

---

## If you cannot run wrangler

Nothing here changes production, so there is no risk in waiting — but without one capture the exact
provider cause stays unknown. The honest fallback is to state that it remains unestablished rather
than to infer it. Do **not** paste logs containing anything from the app into an issue or chat.
