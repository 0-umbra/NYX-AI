import { buildConversationMessages, SYSTEM_PROMPT } from "./conversation.js";
import {
  validateAttachments,
  analyzeImage,
  buildAttachmentContext,
  isQuotaError,
  logVisionFailure,
  visionFailureResponse,
  ATTACHMENT_BODY_LIMIT,
  TEXT_ONLY_BODY_LIMIT,
  DEFAULT_ATTACHMENT_PROMPT
} from "./attachments.js";

const PROJECT_ID = "nyx-ai-1617b";
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const ALLOWED_ORIGIN = "https://localhost";

const CLOCK_TOLERANCE = 60;
const FREE_MODEL = "@cf/zai-org/glm-4.7-flash";

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

/**
 * Reads the body with a hard streaming cap. The cap is always bounded: text-only requests are
 * re-checked against TEXT_ONLY_BODY_LIMIT after parsing (attachments payloads get the wider,
 * still strict, ATTACHMENT_BODY_LIMIT). Returns the decoded text and the byte count.
 */
async function readLimitedBody(request, maxBytes) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maxBytes) throw new Error("BODY_TOO_LARGE");
  if (!request.body) throw new Error("INVALID_BODY");

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;

      if (total > maxBytes) {
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

  return { text: new TextDecoder().decode(bytes), bytes: total };
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
    let rawBodyBytes = 0;
    try {
      const limited = await readLimitedBody(request, ATTACHMENT_BODY_LIMIT);
      body = JSON.parse(limited.text);
      rawBodyBytes = limited.bytes;
    } catch (error) {
      if (error.message === "BODY_TOO_LARGE") {
        return json({ error: "Request is too large." }, 413, origin);
      }
      return json({ error: "Invalid JSON request." }, 400, origin);
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "Invalid JSON request." }, 400, origin);
    }

    const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;

    // The 64 KiB limit stays in force for text-only requests; attachment payloads get the wider,
    // still strict, cap enforced while streaming above.
    if (!hasAttachments && rawBodyBytes > TEXT_ONLY_BODY_LIMIT) {
      return json({ error: "Request is too large." }, 413, origin);
    }

    const attachmentsResult = validateAttachments(body.attachments);
    if (!attachmentsResult.ok) {
      // A rejected attachment never reaches the vision call, so without this the stage that
      // fails *before* inference (base64 decoding, magic bytes, size caps) would leave no trace
      // at all -- and "decode rejected the image" would look identical to "the model failed".
      // Only fixed categories and integer codes are logged; never the payload or the file name.
      const isImage = Array.isArray(body.attachments) &&
        body.attachments.some((attachment) => attachment?.kind === "image");
      logVisionFailure({
        stage: isImage ? "validation.image" : "validation.document",
        category: attachmentsResult.category || "AI_INVALID_REQUEST",
        status: attachmentsResult.status || 400,
        providerCode: null
      });
      return json({ error: attachmentsResult.error }, attachmentsResult.status || 400, origin);
    }
    const attachments = attachmentsResult.attachments;

    if (body.model !== "free") {
      return json({ error: "This model tier is not available yet." }, 403, origin);
    }

    if (body.conversationId !== undefined &&
        (typeof body.conversationId !== "string" || body.conversationId.length > 100)) {
      return json({ error: "Invalid conversation identifier." }, 400, origin);
    }

    // Direct API callers may send an attachment-only message with a blank final user turn;
    // give it a sensible default question instead of dropping it. Never invent a turn otherwise.
    let messageInput = body?.messages;
    if (attachments.length > 0 && Array.isArray(messageInput)) {
      const last = messageInput[messageInput.length - 1];
      if (last && last.role === "user" && typeof last.content === "string" && !last.content.trim()) {
        messageInput = [...messageInput.slice(0, -1), { ...last, content: DEFAULT_ATTACHMENT_PROMPT }];
      }
    }

    const conversation = buildConversationMessages(messageInput);
    if (conversation.error) {
      return json({ error: conversation.error }, conversation.status || 400, origin);
    }

    // Run one bounded vision-model query per attached image (never retried). Done after all
    // validation and before the chat model so the FREE model receives real image content,
    // not filenames. Analyses are kept for the language model and returned to the client so
    // follow-up questions retain the extracted context.
    const analyses = new Array(attachments.length).fill(null);
    const userText = conversation.messages.at(-1)?.content ?? "";
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      if (attachment.kind !== "image") continue;
      try {
        analyses[index] = await analyzeImage(env.AI, attachment, userText);
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : null;
        const providerCode = Number.isInteger(error?.providerCode) ? error.providerCode : null;
        // One sanitized diagnostic per failed vision call: stage, category, status and the
        // Workers AI numeric code only. No image, prompt, file name or provider message.
        logVisionFailure({
          stage: attachment.ocr ? "vision.ocr_page" : "vision.image",
          category: error?.code ?? "AI_FAILED",
          status,
          providerCode
        });

        // Distinct, actionable causes get distinct user-facing messages; the body is built from
        // fixed strings only, so no provider text can ever be forwarded.
        const { status: failureStatus, body: failureBody } = visionFailureResponse(error?.code ?? "AI_FAILED");
        return json(failureBody, failureStatus, origin);
      }
    }
    const imageAttachments = attachments.filter((attachment) => attachment.kind === "image");

    try {
      // The FREE model keeps its existing id and request shape; the conversation history is
      // forwarded as messages so the model can follow up on earlier turns. Attachment
      // context (image analyses, document text) is appended to the newest user turn for
      // this call only — validated history is never mutated.
      let glmMessages = conversation.messages;
      let systemPrompt = SYSTEM_PROMPT;
      if (attachments.length > 0) {
        const context = buildAttachmentContext(attachments, analyses);
        const lastIndex = glmMessages.length - 1;
        glmMessages = [
          ...glmMessages.slice(0, lastIndex),
          { ...glmMessages[lastIndex], content: glmMessages[lastIndex].content + context }
        ];
        systemPrompt += " The user attached files to the latest message; their extracted contents are appended to it. Answer using them, and say plainly when the attachments do not contain the requested information.";
      }

      // The FREE model keeps its existing id and request shape; the conversation history is
      // forwarded as messages so the model can follow up on earlier turns.
      const result = await env.AI.run(FREE_MODEL, {
        messages: [
          { role: "system", content: systemPrompt },
          ...glmMessages
        ],
        max_tokens: 700,
        chat_template_kwargs: { enable_thinking: false }
      });

      // GLM uses the chat-completions shape; retain support for older models.
      const reply = result?.choices?.[0]?.message?.content ?? result?.response;
      if (typeof reply !== "string" || !reply.trim()) {
        return json({ error: "The AI returned an empty response." }, 502, origin);
      }

      const payload = { reply };
      if (imageAttachments.length > 0) {
        payload.attachmentResults = attachments
          .map((attachment, index) => attachment.kind === "image"
            ? { name: attachment.name, analysis: analyses[index] }
            : null)
          .filter(Boolean);
      }
      return json(payload, 200, origin);
    } catch (error) {
      // Provider errors may contain request data; do not log their contents.
      if (isQuotaError(error)) {
        return json({
          error: "The free daily AI quota is exhausted. It resets at 00:00 UTC.",
          quotaExhausted: true
        }, 429, origin);
      }
      console.error("Workers AI request failed.");

      return json({
        error: "The AI service is temporarily unavailable. Please try again later."
      }, 503, origin);
    }
  }
};
