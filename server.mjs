import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";
import { MODEL_TIMEOUT_MS, parseInput, triage } from "./triage.mjs";

const MAX_BODY_BYTES = 16 * 1024;
const html = await readFile(new URL("./index.html", import.meta.url));
const uiScript = await readFile(new URL("./ui.mjs", import.meta.url));

class BodyTooLargeError extends Error {}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function log(event) {
  if (process.env.NODE_ENV === "test") return;
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
}

async function handleTriage(request, response, { classify, timeoutMs }) {
  let body;
  try {
    body = JSON.parse(await readBody(request));
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return json(response, 413, { status: "payload_too_large" });
    }
    return json(response, 400, { status: "invalid_input" });
  }

  const text = parseInput(body);
  if (text === null) return json(response, 400, { status: "invalid_input" });

  const startedAt = performance.now();
  const { result, reason } = await triage(text, { classify, timeoutMs });
  // One structured line per request: manual_review rate and reasons are the health metric.
  log({ event: "triage", status: result.status, reason, ms: Math.round(performance.now() - startedAt) });
  return json(response, 200, result);
}

export function createApp({ classify = mockClassify, timeoutMs = MODEL_TIMEOUT_MS } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method === "GET" && request.url === "/ui.mjs") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(uiScript);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response, { classify, timeoutMs });
    } catch (error) {
      log({ event: "server_error", message: error?.message });
      if (!response.headersSent) json(response, 500, { status: "server_error" });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, "127.0.0.1", () => console.log(`Listening on http://127.0.0.1:${port}`));
}
