const PROJECT_ID = "nyx-ai-1617b";
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const ALLOWED_ORIGIN = "https://localhost";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_TOTAL_CHARS = 24000;
const CLOCK_TOLERANCE = 60;

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};

let jwksCache = null;
let jwksExpiry = 0;

function json(data, status = 200, origin = null) {
  const headers = { ...JSON_HEADERS };
  if (origin === ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
    headers["Vary"] = "Origin";
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

async function getJwks(forceRefresh = false) {
  if (!forceRefresh && jwksCache && Date.now() < jwksExpiry) {
    return jwksCache;
  }

  const response = await fetch(JWKS_URL, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 3600, cacheEverything: true }
  });

  if (!response.ok) throw new Error("Unable to retrieve Firebase signing keys.");

  const data = await response.json();
  if (!Array.isArray(data.keys) || data.keys.length === 0) {
    throw new Error("Invalid Firebase signing keys.");
  }

  jwksCache = data.keys;
  jwksExpiry = Date.now() + 60 * 60 * 1000;
  return jwksCache;
}

async function verifyFirebaseToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9._-]+)$/);

  if (!match || match[1].length > 8192) {
    throw new Error("UNAUTHORIZED");
  }

  const token = match[1];
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("UNAUTHORIZED");

  let header;
  let claims;

  try {
    header = decodeJsonPart(parts[0]);
    claims = decodeJsonPart(parts[1]);
  } catch {
    throw new Error("UNAUTHORIZED");
  }

  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new Error("UNAUTHORIZED");
  }

  const now = Math.floor(Date.now() / 1000);

  if (
    claims.iss !== ISSUER ||
    claims.aud !== PROJECT_ID ||
    typeof claims.sub !== "string" ||
    claims.sub.length === 0 ||
    claims.sub.length > 128 ||
    !Number.isInteger(claims.exp) ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.auth_time) ||
    claims.exp <= now - CLOCK_TOLERANCE ||
    claims.iat > now + CLOCK_TOLERANCE ||
    claims.auth_time > now + CLOCK_TOLERANCE ||
    claims.auth_time > claims.iat + CLOCK_TOLERANCE ||
    (claims.nbf !== undefined &&
      (!Number.isInteger(claims.nbf) || claims.nbf > now + CLOCK_TOLERANCE))
  ) {
    throw new Error("UNAUTHORIZED");
  }

  let keys = await getJwks();
  let jwk = keys.find(key => key.kid === header.kid);

  if (!jwk) {
    keys = await getJwks(true);
    jwk = keys.find(key => key.kid === header.kid);
  }

  if (!jwk || jwk.kty !== "RSA" || jwk.use !== "sig" ||
      (jwk.alg && jwk.alg !== "RS256")) {
    throw new Error("UNAUTHORIZED");
  }

  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = decodeBase64Url(parts[2]);

    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      signature,
      signedData
    );

    if (!valid) throw new Error("UNAUTHORIZED");
  } catch {
    throw new Error("UNAUTHORIZED");
  }

  return claims.sub;
}

async function readLimitedBody(request) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
  if (!request.body) throw new Error("INVALID_BODY");

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;

      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("BODY_TOO_LARGE");
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(bytes);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (origin && origin !== ALLOWED_ORIGIN) {
      return json({ error: "Origin not allowed." }, 403);
    }

    if (request.method === "OPTIONS") {
      if (origin !== ALLOWED_ORIGIN) {
        return json({ error: "Origin not allowed." }, 403);
      }

      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin"
        }
      });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ status: "ok", service: "NYX AI Backend" }, 200, origin);
    }

    if (url.pathname !== "/chat") {
      return json({ error: "Route not found." }, 404, origin);
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405, origin);
    }

    if (origin !== ALLOWED_ORIGIN) {
      return json({ error: "Origin not allowed." }, 403);
    }

    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
      return json({ error: "JSON content type required." }, 415, origin);
    }

    // Authenticate before consuming rate-limit capacity or processing chat data.
    let uid;
    try {
      uid = await verifyFirebaseToken(request);
    } catch {
      return json({ error: "Authentication required. Please sign in again." }, 401, origin);
    }

    if (!env.CHAT_LIMITER || !env.AI) {
      return json({ error: "Chat service is not configured." }, 503, origin);
    }

    try {
      const limit = await env.CHAT_LIMITER.limit({ key: uid });
      if (!limit.success) {
        return json({ error: "Too many requests. Please wait before trying again." }, 429, origin);
      }
    } catch {
      return json({ error: "Chat service is temporarily unavailable." }, 503, origin);
    }

    let body;
    try {
      body = JSON.parse(await readLimitedBody(request));
    } catch (error) {
      if (error.message === "BODY_TOO_LARGE") {
        return json({ error: "Request is too large." }, 413, origin);
      }
      return json({ error: "Invalid JSON request." }, 400, origin);
    }

    if (!body || !Array.isArray(body.messages) ||
        body.messages.length === 0 || body.messages.length > MAX_MESSAGES) {
      return json({ error: "Invalid conversation length." }, 400, origin);
    }

    if (body.model !== "free") {
      return json({ error: "This model tier is not available yet." }, 403, origin);
    }

    if (body.conversationId !== undefined &&
        (typeof body.conversationId !== "string" || body.conversationId.length > 100)) {
      return json({ error: "Invalid conversation identifier." }, 400, origin);
    }

    let totalChars = 0;

    for (const message of body.messages) {
      if (!message || !["user", "assistant"].includes(message.role) ||
          typeof message.content !== "string" || !message.content.trim() ||
          message.content.length > MAX_MESSAGE_LENGTH) {
        return json({ error: "Invalid message format." }, 400, origin);
      }
      totalChars += message.content.length;
    }

    if (totalChars > MAX_TOTAL_CHARS) {
      return json({ error: "Conversation is too large." }, 413, origin);
    }

    if (body.messages[body.messages.length - 1].role !== "user") {
      return json({ error: "The latest message must be from the user." }, 400, origin);
    }

    try {
      const result = await env.AI.run("@cf/zai-org/glm-4.7-flash", {
        messages: [
          {
            role: "system",
            content: "You are NYX AI, a helpful, accurate and respectful AI assistant."
          },
          ...body.messages
        ],
        max_tokens: 700
      });

      const reply = result?.response;
      if (typeof reply !== "string" || !reply.trim()) {
        return json({ error: "The AI returned an empty response." }, 502, origin);
      }

      return json({ reply }, 200, origin);
    } catch (error) {
      console.error("Workers AI request failed:", {
        name: error?.name || "UnknownError",
        message: String(error?.message || "No error message").slice(0, 500)
      });

      return json({
        error: "The AI service is temporarily unavailable. Please try again later."
      }, 503, origin);
    }
  }
};
