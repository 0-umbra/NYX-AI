/**
 * Exercises the real AI binding in Wrangler's pinned workerd runtime, with a local HTTP upstream.
 * No Cloudflare account, credentials, remote inference or paid API is used.
 *
 * This catches the boundary PR #14's plain-object mocks missed: workerd compares Content-Type
 * literally to "application/json", so a JSON response with a charset parameter becomes a body
 * stream even when the request explicitly says stream:false.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import workerd, { compatibilityDate } from "workerd";
import { VISION_MODEL } from "../src/attachments.js";

// workerd's CJS entry exports { default: binaryPath, compatibilityDate, version }.
const workerdPath = workerd.default ?? workerd;
const source = fileURLToPath(new URL("../src/attachments.js", import.meta.url));
const answer = "Receipt total: 42.50; text: café.";

async function runWithContentType(contentType) {
  const dir = await mkdtemp(path.join(tmpdir(), "nyx-vision-runtime-"));
  try {
    await copyFile(source, path.join(dir, "attachments.js"));
    await writeFile(path.join(dir, "test.js"), `
import { analyzeImage } from "./attachments.js";
export let test = {
  async test(controller, env) {
    const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const result = await analyzeImage(env.AI, { data: image, ocr: false }, "Read this receipt");
    if (result !== ${JSON.stringify(answer)}) throw new Error("Valid image answer was not returned");
  }
};
`);
    await writeFile(path.join(dir, "mock.js"), `
export default {
  async fetch(request) {
    const { inputs } = await request.json();
    if (request.headers.get("cf-consn-model-id") !== ${JSON.stringify(VISION_MODEL)}) throw new Error("Wrong model");
    if (inputs.task !== "query" || inputs.stream !== false || inputs.reasoning !== false || inputs.max_tokens !== 640) {
      throw new Error("Unexpected vision inputs");
    }
    if (!inputs.image.startsWith("data:image/png;base64,") || typeof inputs.question !== "string") {
      throw new Error("Unexpected image payload");
    }
    return new Response(JSON.stringify({
      finish_reason: "stop",
      metrics: { input_tokens: 12, output_tokens: 9, prefill_time_ms: 1, decode_time_ms: 2, ttft_ms: 1 },
      answer: ${JSON.stringify(answer)}, caption: null, points: null, objects: null, reasoning: null
    }), { headers: { "Content-Type": ${JSON.stringify(contentType)} } });
  }
};
`);
    const config = `
using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "vision-test", worker = (
      compatibilityDate = ${JSON.stringify(compatibilityDate)},
      modules = [
        (name = "test.js", esModule = embed "test.js"),
        (name = "attachments.js", esModule = embed "attachments.js")
      ],
      bindings = [(name = "AI", wrapped = (
        moduleName = "cloudflare-internal:ai-api",
        innerBindings = [(name = "fetcher", service = "vision-mock")]
      ))]
    )),
    (name = "vision-mock", worker = (
      compatibilityDate = ${JSON.stringify(compatibilityDate)},
      modules = [(name = "mock.js", esModule = embed "mock.js")]
    ))
  ]
);
`;
    const configPath = path.join(dir, "config.capnp");
    await writeFile(configPath, config);
    return spawnSync(workerdPath, ["test", configPath, "--verbose"], {
      cwd: dir, env: { ...process.env, PWD: dir }, encoding: "utf8", timeout: 15000
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

for (const contentType of ["application/json", "application/json; charset=utf-8"]) {
  test(`real AI binding: non-streaming Moondream JSON survives Content-Type "${contentType}"`, async () => {
    const result = await runWithContentType(contentType);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stderr, /\[ PASS \] vision-test:test/);
    assert.equal(result.error, undefined);
  });
}
