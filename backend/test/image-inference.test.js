/**
 * Regression tests for the image-inference path (Workers AI / Moondream).
 *
 * These cover the failure modes that were previously indistinguishable in production, where
 * every image request surfaced as one opaque 502:
 *
 *  - success (a documented `answer` response reaches the chat model and the client);
 *  - malformed provider responses (no `answer`, a non-string `answer`, a non-object response);
 *  - an empty answer;
 *  - provider errors (generic failure, plan gate, missing/deprecated model, oversized payload,
 *    timeout, out of capacity) mapped to distinct, actionable, sanitized messages;
 *  - timeouts (the bounded race, never a retry);
 *  - the base64 decode hot path, which must stay inside Workers Free's 10 ms CPU budget;
 *  - diagnostics: structured, sanitized, and free of image data, prompt text and provider text.
 *
 * Every provider error used here carries a recognizable "sensitive" marker; each test asserts
 * that marker never reaches the client and never reaches the diagnostic record.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { Buffer } from "node:buffer";
import worker from "../src/index.js";
import {
  VISION_MODEL,
  analyzeImage,
  classifyVisionFailure,
  decodeDataUriImage,
  logVisionFailure,
  MAX_IMAGE_BYTES,
  VISION_TIMEOUT_MS
} from "../src/attachments.js";

const ORIGIN = "https://localhost";
const PROJECT_ID = "nyx-ai-1617b";
const SENSITIVE = "SECRET-PROVIDER-INTERNALS";
const GLM_MODEL = "@cf/zai-org/glm-4.7-flash";

const keyPair = await webcrypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"]
);
const publicJwk = {
  ...(await webcrypto.subtle.exportKey("jwk", keyPair.publicKey)),
  kid: "nyx-image-test-key", alg: "RS256", use: "sig"
};
// The Worker fetches Firebase's JWKS; serve our key. Nothing else is fetched by any test here.
globalThis.fetch = async () => new Response(
  JSON.stringify({ keys: [publicJwk] }),
  { status: 200, headers: { "Content-Type": "application/json" } }
);

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
async function makeToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "RS256", typ: "JWT", kid: "nyx-image-test-key" });
  const claims = encode({
    iss: `https://securetoken.google.com/${PROJECT_ID}`, aud: PROJECT_ID, sub: "image-test-user",
    iat: now, exp: now + 3600, auth_time: now
  });
  const content = `${header}.${claims}`;
  const signature = await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(content));
  return `${content}.${Buffer.from(signature).toString("base64url")}`;
}
const TOKEN = await makeToken();

const post = (body) => new Request("https://nyx.test/chat", {
  method: "POST",
  headers: {
    Origin: ORIGIN,
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify(body)
});

// --- fixtures ---------------------------------------------------------------

// Magic-byte-valid image bodies: large enough to exercise the decoder, small enough to be fast.
const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048, 7)]);
const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 9)]);
const dataUri = (mime, bytes) => `data:${mime};base64,${bytes.toString("base64")}`;

const imageAttachment = (overrides = {}) => ({
  name: "photo.jpg", kind: "image", mime: "image/jpeg", data: dataUri("image/jpeg", jpegBytes), ...overrides
});
const chatBody = (attachments, overrides = {}) => ({
  model: "free",
  messages: [{ role: "user", content: "What is in this image?" }],
  attachments,
  ...overrides
});

/**
 * An env whose AI binding routes the vision model through `vision`, and the chat model through
 * `chat`. `vision` may return a value, throw, or hang (for the timeout test).
 */
function makeEnv({ vision, chat, limiter = { success: true } } = {}) {
  const calls = [];
  const env = {
    CHAT_LIMITER: { limit: async () => limiter },
    AI: {
      run: async (model, inputs) => {
        calls.push({ model, inputs });
        if (model === VISION_MODEL) return vision ? vision(inputs) : { answer: "A tabby cat." };
        return chat ? chat(inputs) : { choices: [{ message: { role: "assistant", content: "GLM answer" } }] };
      }
    }
  };
  return { env, calls };
}

/** Captures console.error output instead of printing it. */
function captureConsole() {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(" ")); };
  return {
    lines,
    restore() { console.error = original; },
    records() {
      return lines
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    }
  };
}

// --- success ----------------------------------------------------------------

test("successful inference: the documented answer reaches the client and the chat model", async () => {
  const { env, calls } = makeEnv({ vision: () => ({ answer: "  A whiteboard with three bullet points.  ", finish_reason: "stop" }) });
  const response = await worker.fetch(post(chatBody([imageAttachment()])), env);
  assert.equal(response.status, 200);

  const data = await response.json();
  assert.equal(data.reply, "GLM answer");
  assert.deepEqual(data.attachmentResults, [{ name: "photo.jpg", analysis: "A whiteboard with three bullet points." }]);

  const [visionCall, glmCall] = calls;
  assert.equal(visionCall.model, VISION_MODEL);
  assert.equal(visionCall.inputs.task, "query", "the documented query task");
  assert.equal(visionCall.inputs.reasoning, false, "no reasoning trace");
  assert.equal(typeof visionCall.inputs.question, "string");
  assert.match(visionCall.inputs.image, /^data:image\/jpeg;base64,/);
  assert.match(glmCall.inputs.messages.at(-1).content, /A whiteboard with three bullet points\./);
});

test("successful inference: a long answer is bounded to MAX_ANALYSIS_CHARS", async () => {
  const { env } = makeEnv({ vision: () => ({ answer: "x".repeat(5000) }) });
  const response = await worker.fetch(post(chatBody([imageAttachment()])), env);
  const data = await response.json();
  assert.equal(data.attachmentResults[0].analysis.length, 1600);
});

test("multiple images are analysed in wire order, one call each", async () => {
  const answers = ["first image analysis", "second image analysis"];
  let index = 0;
  const { env, calls } = makeEnv({ vision: () => ({ answer: answers[index++ % answers.length] }) });
  const response = await worker.fetch(post(chatBody([
    imageAttachment({ name: "one.jpg" }),
    imageAttachment({ name: "two.jpg", data: dataUri("image/png", pngBytes), mime: "image/png" })
  ])), env);
  assert.equal(response.status, 200);
  assert.equal(calls.filter((call) => call.model === VISION_MODEL).length, 2);
  const data = await response.json();
  assert.deepEqual(data.attachmentResults.map((result) => result.name), ["one.jpg", "two.jpg"]);
  assert.deepEqual(data.attachmentResults.map((result) => result.analysis), answers);
});

test("OCR pages reuse the same vision call and are capped at three", async () => {
  const ocrPage = (page) => ({ name: `scan page ${page}.jpg`, kind: "image", mime: "image/jpeg", data: dataUri("image/jpeg", jpegBytes), ocr: true });
  const { env, calls } = makeEnv({ vision: (inputs) => ({ answer: inputs.question.startsWith("Transcribe") ? "Transcribed page text." : "other" }) });
  const response = await worker.fetch(post(chatBody([ocrPage(1), ocrPage(2), ocrPage(3)])), env);
  assert.equal(response.status, 200);
  const visionCalls = calls.filter((call) => call.model === VISION_MODEL);
  assert.equal(visionCalls.length, 3);
  for (const call of visionCalls) assert.match(call.inputs.question, /Transcribe all text/);

  const tooMany = await worker.fetch(post(chatBody([ocrPage(1), ocrPage(2), ocrPage(3), ocrPage(4)])), makeEnv().env);
  assert.equal(tooMany.status, 400);
  assert.match((await tooMany.json()).error, /limited to 3 pages/);
});

// --- malformed provider responses -------------------------------------------

test("malformed provider response: no `answer` field is reported as a bad response", async () => {
  const { env, calls } = makeEnv({ vision: () => ({ caption: "wrong task output", finish_reason: "stop" }) });
  const response = await worker.fetch(post(chatBody([imageAttachment()])), env);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /couldn’t read that image/i);
  assert.equal(calls.filter((call) => call.model === GLM_MODEL).length, 0, "the chat model is not called");
});

test("malformed provider response: a non-string `answer` is rejected, not coerced", async () => {
  for (const answer of [null, 42, { text: "nested" }, ["array"]]) {
    const { env } = makeEnv({ vision: () => ({ answer }) });
    const response = await worker.fetch(post(chatBody([imageAttachment()])), env);
    assert.equal(response.status, 502, `answer=${JSON.stringify(answer)}`);
  }
});

test("malformed provider response: a non-object provider result is rejected", async () => {
  for (const result of [null, undefined, "a string", 17, []]) {
    const { env } = makeEnv({ vision: () => result });
    const response = await worker.fetch(post(chatBody([imageAttachment()])), env);
    assert.equal(response.status, 502, `result=${JSON.stringify(result)}`);
  }
});

test("empty answer is distinguished from a malformed one", async () => {
  const { env } = makeEnv({ vision: () => ({ answer: "   \n\t " }) });
  const response = await worker.fetch(post(chatBody([imageAttachment()])), env);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /couldn’t read that image/i);
});

test("a provider response with reasoning but no answer never leaks the reasoning trace", async () => {
  const { env, calls } = makeEnv({ vision: () => ({ reasoning: { text: `${SENSITIVE} internal chain` }, finish_reason: "stop" }) });
  const response = await worker.fetch(post(chatBody([imageAttachment()])), env);
  const body = await response.text();
  assert.equal(response.status, 502);
  assert.ok(!body.includes(SENSITIVE));
  assert.equal(calls.filter((call) => call.model === GLM_MODEL).length, 0);
});

// --- provider errors --------------------------------------------------------

const providerError = (message, extra = {}) => Object.assign(new Error(`${message} ${SENSITIVE}`), extra);

test("provider error (generic) becomes an honest 502 with no provider text", async () => {
  const { env } = makeEnv({ vision: () => { throw providerError("inference blew up:"); } });
  const response = await worker.fetch(post(chatBody([imageAttachment()])), env);
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.match(body, /couldn't analyse an attached image/);
  assert.ok(!body.includes(SENSITIVE), "provider text must never reach the client");
  assert.ok(!body.includes("blew up"));
});

test("provider error: exhausted free allocation keeps the 00:00 UTC message and quota flag", async () => {
  const { env } = makeEnv({ vision: () => { throw providerError("You have used up your daily free allocation of 10,000 neurons."); } });
  const response = await worker.fetch(post(chatBody([imageAttachment()])), env);
  assert.equal(response.status, 429);
  const data = await response.json();
  assert.equal(data.quotaExhausted, true);
  assert.match(data.error, /resets at 00:00 UTC/);
  assert.ok(!response.headers.get("content-type").includes("text/plain"));
});

test("provider error: a Workers Paid plan gate is reported as unavailable, not as quota or as a retry", async () => {
  const { env } = makeEnv({ vision: () => { throw providerError("This model requires a Workers Paid plan.", { status: 403, code: "5035" }); } });
  const response = await worker.fetch(post(chatBody([imageAttachment()])), env);
  assert.equal(response.status, 503);
  const data = await response.json();
  assert.match(data.error, /unavailable on the current Cloudflare plan/);
  assert.equal(data.quotaExhausted, undefined);
  assert.ok(!JSON.stringify(data).includes(SENSITIVE));
});

test("provider error: a missing or deprecated model is reported as temporarily unavailable", async () => {
  // 3042 is "Invalid model ID", which the platform reports as a 404. "No such model" (5007)
  // arrives as a 400 and has its own category; both are shown as temporarily unavailable.
  for (const extra of [{ status: 410, code: "5028" }]) {
    const { env } = makeEnv({ vision: () => { throw providerError("No such model", extra); } });
    const response = await worker.fetch(post(chatBody([imageAttachment()])), env);
    assert.equal(response.status, 503, JSON.stringify(extra));
    assert.match((await response.json()).error, /temporarily unavailable/);
  }
  const { env } = makeEnv({ vision: () => { throw providerError("No such model or task", { status: 400, code: "5007" }); } });
  const missing = await worker.fetch(post(chatBody([imageAttachment()])), env);
  assert.equal(missing.status, 503);
  assert.match((await missing.json()).error, /temporarily unavailable/);
});

test("provider error: an oversized payload is a 413 the user can act on", async () => {
  const { env } = makeEnv({ vision: () => { throw providerError("Request is too large", { status: 413, code: "3006" }); } });
  const response = await worker.fetch(post(chatBody([imageAttachment()])), env);
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /too large to analyse/);
});

test("provider error: out of capacity is retryable and is NOT reported as exhausted quota", async () => {
  const { env } = makeEnv({ vision: () => { throw providerError("Capacity temporarily exceeded, please try again.", { status: 429, code: "3040" }); } });
  const response = await worker.fetch(post(chatBody([imageAttachment()])), env);
  assert.equal(response.status, 503);
  const data = await response.json();
  assert.equal(data.quotaExhausted, undefined, "capacity is not an exhausted daily allocation");
  assert.equal(data.retryable, true);
  assert.doesNotMatch(data.error, /00:00 UTC/);
});

test("provider error: a resource-limit kill (HTTP 1102) is never surfaced as a network problem", async () => {
  const { env } = makeEnv({ vision: () => { throw providerError("Worker exceeded resource limits", { status: 503 }); } });
  const response = await worker.fetch(post(chatBody([imageAttachment()])), env);
  const data = await response.json();
  assert.equal(response.status, 413);
  assert.match(data.error, /too large to analyse/);
});

test("a vision failure never reaches the chat model and never returns a reply", async () => {
  const { env, calls } = makeEnv({ vision: () => { throw providerError("boom"); } });
  const response = await worker.fetch(post(chatBody([imageAttachment()])), env);
  assert.equal(response.status, 502);
  assert.equal(calls.filter((call) => call.model === GLM_MODEL).length, 0);
  assert.equal((await response.json()).reply, undefined);
});

test("a document-only request never calls the vision model", async () => {
  const { env, calls } = makeEnv();
  const response = await worker.fetch(post(chatBody([
    { name: "report.pdf", kind: "document", mime: "application/pdf", text: "Quarterly revenue grew 12%." }
  ])), env);
  assert.equal(response.status, 200);
  assert.equal(calls.filter((call) => call.model === VISION_MODEL).length, 0);
});

// --- timeouts ---------------------------------------------------------------

test("timeout: a vision call that never settles is bounded by VISION_TIMEOUT_MS", async () => {
  // The real bound is 20 s; waiting it out in a unit test would only slow the suite. Route the
  // env's AI binding through analyzeImage with a short bound instead, and assert the same mapping
  // the Worker applies to the resulting VisionError.
  const t0 = Date.now();
  await assert.rejects(
    () => analyzeImage({ run: () => new Promise(() => {}) }, { data: dataUri("image/jpeg", jpegBytes), ocr: false }, "describe", { timeoutMs: 30 }),
    (error) => {
      assert.equal(error.code, "AI_TIMEOUT");
      assert.equal(error.status, null);
      return true;
    }
  );
  assert.ok(Date.now() - t0 < 2000, "the bounded race returns promptly");

  // The mapping is a pure function, so it is asserted directly rather than by injecting a
  // fabricated error through the route (which would only test the injection).
  const { visionFailureResponse } = await import("../src/attachments.js");
  const mapped = visionFailureResponse("AI_TIMEOUT");
  assert.equal(mapped.status, 503);
  assert.equal(mapped.body.retryable, true);
  assert.match(mapped.body.error, /busy right now/);
});

test("every vision failure category maps to a fixed, sanitized response", async () => {
  const { visionFailureResponse } = await import("../src/attachments.js");
  const categories = [
    "AI_QUOTA", "AI_PLAN_REQUIRED", "AI_MODEL_UNAVAILABLE", "AI_MODEL_DEPRECATED",
    "AI_REQUEST_TOO_LARGE", "AI_RESOURCE_LIMIT", "AI_INVALID_IMAGE_DATA", "AI_TIMEOUT",
    "AI_OUT_OF_CAPACITY", "AI_BAD_RESPONSE", "AI_EMPTY", "AI_FAILED", "SOMETHING_NEW"
  ];
  for (const category of categories) {
    const { status, body } = visionFailureResponse(category);
    assert.ok(Number.isInteger(status) && status >= 400 && status <= 599, category);
    assert.equal(typeof body.error, "string");
    assert.ok(body.error.length > 0 && body.error.length <= 120, `${category} message is short`);
    assert.ok(!/https?:|\bstack\b|\bError:|\n|\t/.test(body.error), `${category} message is prose, not a dump`);
  }
  // Quota is the only mapping that claims the daily allocation is exhausted.
  const quotaFlags = categories.filter((category) => visionFailureResponse(category).body.quotaExhausted === true);
  assert.deepEqual(quotaFlags, ["AI_QUOTA"]);
  // Capacity, not quota, is the retryable one.
  assert.equal(visionFailureResponse("AI_OUT_OF_CAPACITY").body.retryable, true);
  assert.equal(visionFailureResponse("AI_QUOTA").body.retryable, undefined);
});

test("timeout: analyzeImage enforces the bound, never retries and reports AI_TIMEOUT", async () => {
  let calls = 0;
  const ai = { run: () => { calls += 1; return new Promise(() => {}); } };
  await assert.rejects(
    () => analyzeImage(ai, { data: dataUri("image/jpeg", jpegBytes), ocr: false }, "describe", { timeoutMs: 20 }),
    (error) => {
      assert.equal(error.code, "AI_TIMEOUT");
      return true;
    }
  );
  assert.equal(calls, 1, "no automatic retry");
});

// --- classification ---------------------------------------------------------

test("classifyVisionFailure: maps the documented Workers AI error table to categories", () => {
  const cases = [
    [Object.assign(new Error("x"), { status: 403, code: "5035" }), "AI_PLAN_REQUIRED"],
    [Object.assign(new Error("x"), { status: 400, code: "5007" }), "AI_MODEL_UNAVAILABLE"],
    [Object.assign(new Error("x"), { status: 410, code: "5028" }), "AI_MODEL_DEPRECATED"],
    [Object.assign(new Error("x"), { status: 400, code: "5004" }), "AI_INVALID_IMAGE_DATA"],
    [Object.assign(new Error("x"), { status: 413, code: "3006" }), "AI_REQUEST_TOO_LARGE"],
    [Object.assign(new Error("x"), { status: 408, code: "3007" }), "AI_TIMEOUT"],
    [Object.assign(new Error("x"), { status: 429, code: "3040" }), "AI_OUT_OF_CAPACITY"],
    [Object.assign(new Error("x"), { status: 429, code: "3036" }), "AI_QUOTA"],
    [new Error("Worker exceeded resource limits"), "AI_RESOURCE_LIMIT"]
  ];
  for (const [error, expected] of cases) {
    assert.equal(classifyVisionFailure(error).category, expected, `${error.code ?? error.message}`);
  }
});

test("classifyVisionFailure: keeps only a bounded status and numeric code, never the message", () => {
  const failure = classifyVisionFailure(Object.assign(new Error(`${SENSITIVE} at /some/path`), { status: 502 }));
  assert.deepEqual(Object.keys(failure).sort(), ["category", "providerCode", "status"]);
  assert.equal(failure.status, 502);
  assert.ok(!JSON.stringify(failure).includes(SENSITIVE));
  // Nonsense statuses are dropped rather than passed through.
  assert.equal(classifyVisionFailure(Object.assign(new Error("x"), { status: "oops" })).status, null);
});

// --- diagnostics ------------------------------------------------------------

test("diagnostics: one structured, sanitized record per failed vision call", async () => {
  const capture = captureConsole();
  try {
    const { env } = makeEnv({ vision: () => { throw providerError("kaboom", { status: 502, code: "5004" }); } });
    await worker.fetch(post(chatBody([imageAttachment()])), env);
  } finally {
    capture.restore();
  }
  const records = capture.records().filter((record) => record.event === "nyx.vision.failed");
  assert.equal(records.length, 1, "exactly one record per failed call, not per byte or per page");
  assert.deepEqual(Object.keys(records[0]).sort(), ["category", "event", "providerCode", "stage", "status"]);
  assert.equal(records[0].stage, "vision.image");
  assert.equal(records[0].category, "AI_INVALID_IMAGE_DATA");
  // The classification, not the incoming HTTP status, decides the code and status.
  assert.equal(records[0].status, 400);
  assert.equal(records[0].providerCode, 5004);
});

test("diagnostics: never record the image, data URI, base64 payload, file name, prompt or provider text", async () => {
  const capture = captureConsole();
  const marker = "FILENAME-AND-PROMPT-MARKER";
  try {
    const { env } = makeEnv({ vision: () => { throw providerError("provider exploded"); } });
    await worker.fetch(post(chatBody([
      imageAttachment({ name: `${marker}.jpg` })
    ], { messages: [{ role: "user", content: `Please read ${marker} carefully.` }] })), env);
  } finally {
    capture.restore();
  }
  const logged = capture.lines.join("\n");
  const base64Body = jpegBytes.toString("base64").slice(0, 32);
  for (const secret of [marker, SENSITIVE, base64Body, "data:image/jpeg;base64", "provider exploded"]) {
    assert.ok(!logged.includes(secret), `diagnostics must not contain ${JSON.stringify(secret)}`);
  }
  // ...but the safe fields are present.
  assert.match(logged, /"event":"nyx\.vision\.failed"/);
});

test("diagnostics: OCR page failures are tagged as such", async () => {
  const capture = captureConsole();
  try {
    const { env } = makeEnv({ vision: () => { throw providerError("ocr failed"); } });
    await worker.fetch(post(chatBody([
      { name: "scan page 1.jpg", kind: "image", mime: "image/jpeg", data: dataUri("image/jpeg", jpegBytes), ocr: true }
    ])), env);
  } finally {
    capture.restore();
  }
  const record = capture.records().find((entry) => entry.event === "nyx.vision.failed");
  assert.equal(record.stage, "vision.ocr_page");
});

test("diagnostics: logVisionFailure tolerates a logger that throws and ignores non-records", () => {
  assert.doesNotThrow(() => logVisionFailure({ category: "AI_FAILED" }, { logger: { error() { throw new Error("logger down"); } } }));
  assert.doesNotThrow(() => logVisionFailure({}, { logger: { error() {} } }));
  assert.doesNotThrow(() => logVisionFailure(null, {}));
});

// --- the CPU hot path -------------------------------------------------------

test("base64 decode stays inside the Workers Free CPU budget and validates identically", () => {
  // A 1 MiB image is the realistic decoded size the client re-encodes to. The previous decoder
  // (`Uint8Array.from(binary, cb)`) took tens of milliseconds for that — more than the whole
  // 10 ms Workers Free CPU allowance — which killed real image requests at the edge.
  const bigBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1024 * 1024, 5)]);
  const uri = dataUri("image/jpeg", bigBytes);
  assert.equal(uri.length, Math.ceil(bigBytes.length / 3) * 4 + "data:image/jpeg;base64,".length);

  decodeDataUriImage(uri); // warm
  const started = performance.now();
  const runs = 3;
  for (let i = 0; i < runs; i += 1) {
    const decoded = decodeDataUriImage(uri);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.bytes.length, bigBytes.length);
  }
  const perCall = (performance.now() - started) / runs;
  // Generous bound: the loop version is ~1-2 ms per MiB on Node; the callback version is >50 ms.
  // The bound is deliberately far from both so it is a real regression guard, not a flake.
  assert.ok(perCall < 20, `1 MiB base64 decode took ${perCall.toFixed(1)} ms; the CPU-limited path regressed`);
});

test("base64 decode still rejects everything it rejected before", () => {
  assert.equal(decodeDataUriImage("https://example.com/x.png").ok, false);
  assert.equal(decodeDataUriImage("data:image/gif;base64,R0lGODlh").ok, false);
  assert.equal(decodeDataUriImage("data:image/png;base64,not*base64").ok, false);
  assert.equal(decodeDataUriImage(`data:image/png;base64,${Buffer.from("MZ").toString("base64")}`).ok, false);
  // Whitespace inside the payload is not valid base64 for this parser (unchanged behaviour).
  assert.equal(decodeDataUriImage(`data:image/png;base64,${pngBytes.toString("base64").replace(/(.{10})/, "$1 ")}`).ok, false);
  const ok = decodeDataUriImage(dataUri("image/png", pngBytes));
  assert.equal(ok.ok, true);
  assert.equal(ok.mime, "image/png");
  assert.equal(ok.dataUri, dataUri("image/png", pngBytes));
});

test("an image larger than the server cap is still rejected", () => {
  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(MAX_IMAGE_BYTES + 8, 1)]);
  const decoded = decodeDataUriImage(dataUri("image/jpeg", huge));
  assert.equal(decoded.ok, false);
  assert.match(decoded.error, /too large/i);
});

test("the vision timeout stays bounded and documented", () => {
  assert.equal(VISION_TIMEOUT_MS, 20000);
});
