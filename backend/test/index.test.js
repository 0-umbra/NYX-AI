import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { Buffer } from "node:buffer";
import worker from "../src/index.js";

const ORIGIN = "https://localhost";
const PROJECT_ID = "nyx-ai-1617b";

const keyPair = await webcrypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  },
  true,
  ["sign", "verify"]
);

const publicJwk = {
  ...(await webcrypto.subtle.exportKey("jwk", keyPair.publicKey)),
  kid: "nyx-test-key",
  alg: "RS256",
  use: "sig"
};

// Mock Google's public signing-key endpoint. No network request is made.
globalThis.fetch = async () => new Response(
  JSON.stringify({ keys: [publicJwk] }),
  { status: 200, headers: { "Content-Type": "application/json" } }
);

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function makeToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);

  const header = encode({
    alg: "RS256",
    typ: "JWT",
    kid: "nyx-test-key"
  });

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

function makeRequest(path, options = {}) {
  const { auth = true, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers || {});

  headers.set("Origin", ORIGIN);
  headers.set("CF-Connecting-IP", "127.0.0.1");

  if (auth && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${TOKEN}`);
  }

  if (requestOptions.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return new Request(`https://nyx.test${path}`, {
    ...requestOptions,
    headers
  });
}

function makeEnv(overrides = {}) {
  return {
    CHAT_LIMITER: {
      limit: async () => ({ success: true })
    },
    AI: {
      run: async () => ({ response: "Hello! I am NYX AI." })
    },
    ...overrides
  };
}

test("health endpoint responds successfully", async () => {
  const response = await worker.fetch(
    new Request("https://nyx.test/health"),
    {}
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});

test("unknown routes return 404", async () => {
  const response = await worker.fetch(makeRequest("/unknown"), makeEnv());
  assert.equal(response.status, 404);
});

test("unauthorized origins are rejected", async () => {
  const request = new Request("https://nyx.test/chat", {
    method: "POST",
    headers: {
      Origin: "https://example.com",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });

  const response = await worker.fetch(request, makeEnv());
  assert.equal(response.status, 403);
});

test("CORS preflight accepts the app origin and Authorization header", async () => {
  const response = await worker.fetch(
    makeRequest("/", {
      method: "OPTIONS",
      auth: false,
      headers: { "Access-Control-Request-Headers": "authorization,content-type" }
    }),
    makeEnv()
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.match(
    response.headers.get("Access-Control-Allow-Headers"),
    /Authorization/i
  );
});

test("chat rejects requests without Firebase authentication", async () => {
  const response = await worker.fetch(
    makeRequest("/chat", {
      method: "POST",
      auth: false,
      body: JSON.stringify({
        model: "free",
        messages: [{ role: "user", content: "Hello" }]
      })
    }),
    makeEnv()
  );

  assert.equal(response.status, 401);
});

test("chat rejects invalid Firebase signatures", async () => {
  const token = await makeToken();
  const parts = token.split(".");
  parts[2] = Buffer.alloc(256).toString("base64url");

  const response = await worker.fetch(
    makeRequest("/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${parts.join(".")}` },
      body: JSON.stringify({
        model: "free",
        messages: [{ role: "user", content: "Hello" }]
      })
    }),
    makeEnv()
  );

  assert.equal(response.status, 401);
});

test("chat rejects tokens with the wrong audience", async () => {
  const token = await makeToken({ aud: "wrong-project" });

  const response = await worker.fetch(
    makeRequest("/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: "free",
        messages: [{ role: "user", content: "Hello" }]
      })
    }),
    makeEnv()
  );

  assert.equal(response.status, 401);
});

test("chat fails closed when rate limiter is missing", async () => {
  const response = await worker.fetch(
    makeRequest("/chat", {
      method: "POST",
      body: JSON.stringify({})
    }),
    { AI: { run: async () => ({ response: "unexpected" }) } }
  );

  assert.equal(response.status, 503);
});

test("rate limiting uses the verified Firebase UID", async () => {
  let rateLimitKey;

  const response = await worker.fetch(
    makeRequest("/chat", {
      method: "POST",
      body: JSON.stringify({
        model: "free",
        messages: [{ role: "user", content: "Hello" }]
      })
    }),
    makeEnv({
      CHAT_LIMITER: {
        limit: async ({ key }) => {
          rateLimitKey = key;
          return { success: false };
        }
      }
    })
  );

  assert.equal(rateLimitKey, "test-user-123");
  assert.equal(response.status, 429);
});

test("invalid JSON returns 400", async () => {
  const response = await worker.fetch(
    makeRequest("/chat", { method: "POST", body: "not-json" }),
    makeEnv()
  );

  assert.equal(response.status, 400);
});

test("missing messages return 400", async () => {
  const response = await worker.fetch(
    makeRequest("/chat", {
      method: "POST",
      body: JSON.stringify({ model: "free" })
    }),
    makeEnv()
  );

  assert.equal(response.status, 400);
});

test("unsupported model tiers are rejected", async () => {
  let aiCalled = false;

  const response = await worker.fetch(
    makeRequest("/chat", {
      method: "POST",
      body: JSON.stringify({
        model: "pro",
        messages: [{ role: "user", content: "Hello" }]
      })
    }),
    makeEnv({
      AI: {
        run: async () => {
          aiCalled = true;
          return { response: "unexpected" };
        }
      }
    })
  );

  assert.equal(response.status, 403);
  assert.equal(aiCalled, false);
});

test("too many messages are rejected", async () => {
  const response = await worker.fetch(
    makeRequest("/chat", {
      method: "POST",
      body: JSON.stringify({
        model: "free",
        messages: Array.from({ length: 13 }, () => ({
          role: "user",
          content: "Hello"
        }))
      })
    }),
    makeEnv()
  );

  assert.equal(response.status, 400);
});

test("oversized message content is rejected", async () => {
  const response = await worker.fetch(
    makeRequest("/chat", {
      method: "POST",
      body: JSON.stringify({
        model: "free",
        messages: [{ role: "user", content: "a".repeat(4001) }]
      })
    }),
    makeEnv()
  );

  assert.equal(response.status, 400);
});

test("latest message must be from the user", async () => {
  const response = await worker.fetch(
    makeRequest("/chat", {
      method: "POST",
      body: JSON.stringify({
        model: "free",
        messages: [{ role: "assistant", content: "Hello" }]
      })
    }),
    makeEnv()
  );

  assert.equal(response.status, 400);
});

test("valid authenticated free chat returns the AI response", async () => {
  const response = await worker.fetch(
    makeRequest("/chat", {
      method: "POST",
      body: JSON.stringify({
        model: "free",
        messages: [{ role: "user", content: "Hello NYX" }]
      })
    }),
    makeEnv()
  );

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.reply, "Hello! I am NYX AI.");
});

test("GLM chat-completion content is returned with thinking disabled", async () => {
  let call;
  const response = await worker.fetch(
    makeRequest("/chat", {
      method: "POST",
      body: JSON.stringify({ model: "free", messages: [{ role: "user", content: "Hello" }] })
    }),
    makeEnv({ AI: { run: async (model, inputs) => {
      call = { model, inputs };
      return { choices: [{ message: { role: "assistant", content: "GLM answer", reasoning_content: "private reasoning" }, finish_reason: "stop" }] };
    } } })
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reply: "GLM answer" });
  assert.equal(call.model, "@cf/zai-org/glm-4.7-flash");
  assert.equal(call.inputs.max_tokens, 700);
  assert.deepEqual(call.inputs.chat_template_kwargs, { enable_thinking: false });
});

test("empty GLM content never exposes reasoning and returns 502", async () => {
  const response = await worker.fetch(
    makeRequest("/chat", { method: "POST", body: JSON.stringify({ model: "free", messages: [{ role: "user", content: "Hello" }] }) }),
    makeEnv({ AI: { run: async () => ({ choices: [{ message: { content: null, reasoning_content: "private reasoning" }, finish_reason: "length" }] }) } })
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "The AI returned an empty response." });
});

test("provider failures return a sanitized 503", async () => {
  const response = await worker.fetch(
    makeRequest("/chat", { method: "POST", body: JSON.stringify({ model: "free", messages: [{ role: "user", content: "Hello" }] }) }),
    makeEnv({ AI: { run: async () => { throw new Error("sensitive provider detail"); } } })
  );
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /sensitive provider detail/);
});

test("max tier remains unavailable without invoking AI", async () => {
  let called = false;
  const response = await worker.fetch(
    makeRequest("/chat", { method: "POST", body: JSON.stringify({ model: "max", messages: [{ role: "user", content: "Hello" }] }) }),
    makeEnv({ AI: { run: async () => { called = true; } } })
  );
  assert.equal(response.status, 403);
  assert.equal(called, false);
});
