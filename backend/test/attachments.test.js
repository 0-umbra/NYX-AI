/**
 * Attachment tests for the /chat endpoint. The vision (Moondream) and chat (GLM) models are both
 * served by the same mocked env.AI binding, separately identifiable by model id, and no network
 * request of any kind is made. Nothing received by the Worker is persisted by design — one test
 * scans the Worker source for persistence APIs to catch regressions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { Buffer } from "node:buffer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";
import {
  decodeDataUriImage,
  validateAttachments,
  buildVisionQuestion,
  buildAttachmentContext,
  isQuotaError,
  VISION_MODEL
} from "../src/attachments.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ORIGIN = "https://localhost";
const PROJECT_ID = "nyx-ai-1617b";

const keyPair = await webcrypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"]
);

const publicJwk = {
  ...(await webcrypto.subtle.exportKey("jwk", keyPair.publicKey)),
  kid: "nyx-test-key",
  alg: "RS256",
  use: "sig"
};

globalThis.fetch = async () => new Response(
  JSON.stringify({ keys: [publicJwk] }),
  { status: 200, headers: { "Content-Type": "application/json" } }
);

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function makeToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "RS256", typ: "JWT", kid: "nyx-test-key" });
  const claims = encode({
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: "test-user-123",
    iat: now,
    exp: now + 3600,
    auth_time: now,
    ...overrides
  });
  const content = `${header}.${claims}`;
  const signature = await webcrypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(content)
  );
  return `${content}.${Buffer.from(signature).toString("base64url")}`;
}

const TOKEN = await makeToken();

function makeRequest(options = {}) {
  const { auth = true, headers = {}, ...rest } = options;
  const finalHeaders = new Headers(headers);
  finalHeaders.set("Origin", ORIGIN);
  finalHeaders.set("CF-Connecting-IP", "127.0.0.1");
  if (auth && !finalHeaders.has("Authorization")) finalHeaders.set("Authorization", `Bearer ${TOKEN}`);
  if (rest.body !== undefined && !finalHeaders.has("Content-Type")) finalHeaders.set("Content-Type", "application/json");
  return new Request("https://nyx.test/chat", { method: "POST", ...rest, headers: finalHeaders });
}

const GLM_MODEL = "@cf/zai-org/glm-4.7-flash";

function makeEnv(overrides = {}) {
  const calls = [];
  const env = {
    CHAT_LIMITER: { limit: async () => ({ success: true }) },
    AI: {
      run: async (model, inputs) => {
        calls.push({ model, inputs });
        if (model === VISION_MODEL) return { answer: "A tabby cat sitting on a sofa.", finish_reason: "stop" };
        return { choices: [{ message: { role: "assistant", content: "GLM answer" } }] };
      }
    },
    ...overrides
  };
  return { env, calls };
}

// --- fixtures --------------------------------------------------------------

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.alloc(64, 7)]);
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(64, 9)]);
const webpBytes = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x40, 0x00, 0x00, 0x00]), Buffer.from("WEBPVP8 "), Buffer.alloc(32, 3)]);
const dataUri = (mime, bytes) => `data:${mime};base64,${bytes.toString("base64")}`;

const pngImage = (overrides = {}) => ({
  name: "screenshot.png", kind: "image", mime: "image/png", data: dataUri("image/png", pngBytes), ...overrides
});
const jpegImage = (overrides = {}) => ({
  name: "photo.jpg", kind: "image", mime: "image/jpeg", data: dataUri("image/jpeg", jpegBytes), ...overrides
});
const documentAttachment = (overrides = {}) => ({
  name: "report.pdf", kind: "document", mime: "application/pdf",
  text: "NYX AI quarterly review. Revenue grew 12% year over year.", ...overrides
});
const chatBody = (overrides = {}) => ({
  model: "free",
  messages: [{ role: "user", content: "Summarise this for me." }],
  ...overrides
});
const send = (body, options) => makeRequest({ body: JSON.stringify(body), ...options });

// --- authentication and rate limiting come first ----------------------------

test("attachments require Firebase authentication", async () => {
  const { env, calls } = makeEnv();
  const response = await worker.fetch(send(chatBody({ attachments: [pngImage()] }), { auth: false }), env);
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0, "no AI call happens before auth");
});

test("rate limiting covers attachment (vision) requests", async () => {
  let key;
  const { env, calls } = makeEnv({
    CHAT_LIMITER: { limit: async ({ key: k }) => { key = k; return { success: false }; } }
  });
  const response = await worker.fetch(send(chatBody({ attachments: [pngImage()] })), env);
  assert.equal(response.status, 429);
  assert.equal(key, "test-user-123");
  assert.equal(calls.length, 0, "no AI call happens before the rate limiter");
});

// --- image validation --------------------------------------------------------

test("a valid image attachment is analysed by the vision model and reaches GLM", async () => {
  const { env, calls } = makeEnv();
  const response = await worker.fetch(send(chatBody({ attachments: [pngImage()] })), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.reply, "GLM answer");
  assert.deepEqual(data.attachmentResults, [{ name: "screenshot.png", analysis: "A tabby cat sitting on a sofa." }]);

  const [visionCall, glmCall] = calls;
  assert.equal(visionCall.model, VISION_MODEL);
  assert.equal(visionCall.inputs.task, "query");
  assert.equal(visionCall.inputs.reasoning, false);
  assert.match(visionCall.inputs.image, /^data:image\/png;base64,/);
  assert.match(visionCall.inputs.question, /Summarise this for me/);

  const [system, ...glmMessages] = glmCall.inputs.messages;
  assert.equal(system.role, "system");
  const last = glmMessages.at(-1);
  assert.match(last.content, /Summarise this for me/);
  assert.match(last.content, /A tabby cat sitting on a sofa\./);
  assert.match(last.content, /Attached files/);
  assert.equal(glmCall.inputs.max_tokens, 700);
});

test("magic bytes that do not match the declared MIME type are rejected", async () => {
  const { env, calls } = makeEnv();
  const fakePng = { name: "fake.png", kind: "image", mime: "image/png", data: dataUri("image/png", jpegBytes) };
  const response = await worker.fetch(send(chatBody({ attachments: [fakePng] })), env);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /do not match/i);
  assert.equal(calls.length, 0);
});

test("JPEG and WebP signatures are accepted; other content is rejected", async () => {
  for (const attachment of [
    { name: "ok.jpg", kind: "image", mime: "image/jpeg", data: dataUri("image/jpeg", jpegBytes) },
    { name: "ok.webp", kind: "image", mime: "image/webp", data: dataUri("image/webp", webpBytes) }
  ]) {
    const { env } = makeEnv();
    const response = await worker.fetch(send(chatBody({ attachments: [attachment] })), env);
    assert.equal(response.status, 200, attachment.name);
  }
  const { env, calls } = makeEnv();
  const notAnImage = { name: "evil.png", kind: "image", mime: "image/png", data: dataUri("image/png", Buffer.from("MZ-executable-payload")) };
  const response = await worker.fetch(send(chatBody({ attachments: [notAnImage] })), env);
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("a remote image URL is never accepted as an image payload", async () => {
  const { env, calls } = makeEnv();
  const remote = { name: "remote.png", kind: "image", mime: "image/png", data: "https://evil.example/tracker.png" };
  const response = await worker.fetch(send(chatBody({ attachments: [remote] })), env);
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("unsupported file types are rejected with a clear error", async () => {
  const { env, calls } = makeEnv();
  const gif = { name: "anim.gif", kind: "image", mime: "image/gif", data: `data:image/gif;base64,${Buffer.from([0x47, 0x49, 0x46, 0x38]).toString("base64")}` };
  const response = await worker.fetch(send(chatBody({ attachments: [gif] })), env);
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
  const textAsImage = { name: "x.png", kind: "image", mime: "text/plain", data: "data:text/plain;base64,aGVsbG8=" };
  const response2 = await worker.fetch(send(chatBody({ attachments: [textAsImage] })), env);
  assert.equal(response2.status, 400);
});

test("an image larger than the per-file limit is rejected", async () => {
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1_500_001, 1)]);
  const { env, calls } = makeEnv();
  const response = await worker.fetch(send(chatBody({ attachments: [pngImage({ data: dataUri("image/png", big) })] })), env);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /too large/i);
  assert.equal(calls.length, 0);
});

test("more than five attachments are rejected", async () => {
  const attachments = Array.from({ length: 6 }, (_, i) => pngImage({ name: `img-${i}.png` }));
  const { env, calls } = makeEnv();
  const response = await worker.fetch(send(chatBody({ attachments })), env);
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("scanned PDF OCR is limited to three pages", async () => {
  const attachments = Array.from({ length: 4 }, (_, i) => pngImage({ name: `page-${i + 1}.jpg`, kind: "image", mime: "image/jpeg", data: dataUri("image/jpeg", jpegBytes), ocr: true }));
  const { env, calls } = makeEnv();
  const response = await worker.fetch(send(chatBody({ attachments })), env);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /OCR/);
  assert.equal(calls.length, 0);
});

test("multiple images are analysed in order and all reach the model", async () => {
  const attachments = [
    pngImage({ name: "first.png" }),
    jpegImage({ name: "second.jpg" }),
    pngImage({ name: "third.png" })
  ];
  const { env, calls } = makeEnv();
  const response = await worker.fetch(send(chatBody({ attachments })), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.attachmentResults.map((r) => r.name), ["first.png", "second.jpg", "third.png"]);
  const visionCalls = calls.filter((c) => c.model === VISION_MODEL);
  assert.equal(visionCalls.length, 3);
  const glmCall = calls.find((c) => c.model === GLM_MODEL);
  assert.match(glmCall.inputs.messages.at(-1).content, /Image 1 \(first\.png\)/);
  assert.match(glmCall.inputs.messages.at(-1).content, /Image 3 \(third\.png\)/);
});

// --- document attachments ---------------------------------------------------

test("document text is forwarded to GLM but never executed or persisted", async () => {
  const { env, calls } = makeEnv();
  const response = await worker.fetch(send(chatBody({ attachments: [documentAttachment()] })), env);
  assert.equal(response.status, 200);
  const glmCall = calls.find((c) => c.model === GLM_MODEL);
  const content = glmCall.inputs.messages.at(-1).content;
  assert.match(content, /Revenue grew 12%/);
  assert.match(content, /report\.pdf/);
  assert.equal(calls.filter((c) => c.model === VISION_MODEL).length, 0, "documents never call the vision model");
  // attachmentResults is only produced for images
  const data = await response.json();
  assert.equal(data.reply, "GLM answer");
  assert.equal(data.attachmentResults, undefined);
});

test("a document with no readable text is rejected", async () => {
  const { env, calls } = makeEnv();
  const empty = documentAttachment({ text: "   " });
  const response = await worker.fetch(send(chatBody({ attachments: [empty] })), env);
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("oversized documents are rejected individually and in total", async () => {
  const { env: env1, calls: calls1 } = makeEnv();
  const tooBig = documentAttachment({ text: "a".repeat(8001) });
  const response1 = await worker.fetch(send(chatBody({ attachments: [tooBig] })), env1);
  assert.equal(response1.status, 413);
  assert.equal(calls1.length, 0);

  const { env: env2, calls: calls2 } = makeEnv();
  const docs = [
    documentAttachment({ name: "a.txt", mime: "text/plain", text: "a".repeat(8000) }),
    documentAttachment({ name: "b.txt", mime: "text/plain", text: "b".repeat(8000) })
  ];
  const response2 = await worker.fetch(send(chatBody({ attachments: docs })), env2);
  assert.equal(response2.status, 413);
  assert.equal(calls2.length, 0);
});

// --- request size transport -------------------------------------------------

test("text-only requests keep the 64 KiB limit; attachment requests use the bounded wider cap", async () => {
  const pad = "x".repeat(96 * 1024); // ~96 KiB, over the old 64 KiB limit
  const textOnly = await worker.fetch(
    send(chatBody({ messages: [{ role: "user", content: pad }] })),
    makeEnv().env
  );
  assert.equal(textOnly.status, 413);

  const { env } = makeEnv();
  const withAttachment = await worker.fetch(
    send(chatBody({ attachments: [pngImage()], pad })),
    env
  );
  assert.equal(withAttachment.status, 200, "a bounded attachment request under 8 MiB is accepted");
});

test("attachment requests exceeding 8 MiB are rejected while streaming", async () => {
  const pad = "y".repeat(8 * 1024 * 1024 + 16 * 1024);
  const { env, calls } = makeEnv();
  const response = await worker.fetch(
    send(chatBody({ attachments: [pngImage()], pad })),
    env
  );
  assert.equal(response.status, 413);
  assert.equal(calls.length, 0);
});

// --- quota handling ----------------------------------------------------------

test("vision quota exhaustion returns 429 with a reset notice and never retries", async () => {
  let visionCalls = 0;
  const { env } = makeEnv({
    AI: {
      run: async (model) => {
        if (model === VISION_MODEL) { visionCalls += 1; throw new Error("Account exceeded its Workers AI neurons allocation"); }
        return { choices: [{ message: { content: "should not be reached" } }] };
      }
    }
  });
  const response = await worker.fetch(send(chatBody({ attachments: [pngImage()] })), env);
  assert.equal(response.status, 429);
  const data = await response.json();
  assert.equal(data.quotaExhausted, true);
  assert.match(data.error, /00:00 UTC/);
  assert.equal(visionCalls, 1, "no automatic retry consumes extra quota");
});

test("GLM quota exhaustion returns the same 429 notice", async () => {
  const { env } = makeEnv({
    AI: {
      run: async (model) => {
        if (model === VISION_MODEL) return { answer: "cat" };
        const err = new Error("Daily free allocation of neurons exhausted");
        err.code = 429;
        throw err;
      }
    }
  });
  const response = await worker.fetch(send(chatBody({ attachments: [pngImage()] })), env);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).quotaExhausted, true);
});

test("a non-quota vision failure returns a sanitized 502", async () => {
  const { env } = makeEnv({
    AI: {
      run: async (model) => {
        if (model === VISION_MODEL) throw new Error("sensitive provider internals: bucket abc123 exploded");
        return { choices: [{ message: { content: "unreached" } }] };
      }
    }
  });
  const response = await worker.fetch(send(chatBody({ attachments: [pngImage()] })), env);
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.doesNotMatch(text, /sensitive provider internals|abc123/);
});

// --- robustness --------------------------------------------------------------

test("an attachment-only message with a blank user turn is given a default question", async () => {
  const { env, calls } = makeEnv();
  const response = await worker.fetch(send(chatBody({
    messages: [{ role: "user", content: "" }],
    attachments: [pngImage()]
  })), env);
  assert.equal(response.status, 200);
  const glmCall = calls.find((c) => c.model === GLM_MODEL);
  assert.match(glmCall.inputs.messages.at(-1).content, /Analyse the attached files/);
});

test("a falsy image analysis cannot slip into the chat model", async () => {
  const { env } = makeEnv({
    AI: { run: async (model) => (model === VISION_MODEL ? { answer: "   " } : { choices: [{ message: { content: "never" } }] }) }
  });
  const response = await worker.fetch(send(chatBody({ attachments: [pngImage()] })), env);
  assert.equal(response.status, 502);
});

test("the Worker never persists original files or uses storage APIs", () => {
  const sources = ["src/index.js", "src/attachments.js", "src/conversation.js"].map((rel) => readFileSync(path.join(ROOT, "backend", rel), "utf8"));
  for (const source of sources) {
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|CacheStorage|caches\.open|\.put\(|KVNamespace|D1Database|DurableObject|writeFile/);
  }
});

// --- helper-level tests ------------------------------------------------------

test("decodeDataUriImage enforces the data URI shape and signature", () => {
  assert.equal(decodeDataUriImage("data:image/png;base64," + pngBytes.toString("base64")).ok, true);
  assert.equal(decodeDataUriImage("data:image/png;base64,!!!").ok, false);
  assert.equal(decodeDataUriImage("data:image/gif;base64," + pngBytes.toString("base64")).ok, false);
  assert.equal(decodeDataUriImage("http://example.com/x.png").ok, false);
  assert.equal(decodeDataUriImage("data:image/png;base64,AAAA").ok, false); // bad magic
  assert.equal(decodeDataUriImage(`data:image/png;base64,${"A".repeat((1_500_000 * 4) / 3 + 8)}`).ok, false);
});

test("validateAttachments normalises and enforces totals", () => {
  const result = validateAttachments([documentAttachment({ text: "hello world" })]);
  assert.equal(result.ok, true);
  assert.equal(result.attachments[0].text, "hello world");
  assert.equal(validateAttachments("nope").ok, false);
  assert.equal(validateAttachments([{ kind: "mystery", name: "x" }]).ok, false);
  assert.equal(validateAttachments([{ kind: "document", name: "x.pdf", text: "ok", mime: "image/png" }]).ok, false);
});

test("buildVisionQuestion switches between OCR and open questions", () => {
  assert.match(buildVisionQuestion({ ocr: true }, "anything"), /verbatim/i);
  assert.match(buildVisionQuestion({ ocr: false }, "What does the sign say?"), /What does the sign say\?/);
  assert.match(buildVisionQuestion({ ocr: false }, ""), /Describe this image/);
});

test("buildAttachmentContext keeps names and order, document text included", () => {
  const context = buildAttachmentContext(
    [documentAttachment({ name: "contract.pdf" }), pngImage({ name: "scan.png" })],
    [null, "a photo of a receipt"]
  );
  assert.match(context, /Document \(contract\.pdf\)/);
  assert.match(context, /Revenue grew 12%/);
  assert.match(context, /Image 2 \(scan\.png\):\na photo of a receipt/);
});

test("isQuotaError recognises common quota shapes and ignores others", () => {
  assert.equal(isQuotaError(new Error("neurons allocation exhausted")), true);
  assert.equal(isQuotaError({ code: 429 }), true);
  assert.equal(isQuotaError(new Error("model produced empty output")), false);
  assert.equal(isQuotaError(undefined), false);
});
