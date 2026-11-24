// Domain logic for triaging an incoming request with an AI classifier.
// Kept free of HTTP so it can be tested directly and reused (queue worker, CLI).

export const ALLOWED_TOPICS = Object.freeze(["delivery", "pricing", "other"]);
export const MODEL_TIMEOUT_MS = 300;

export const MANUAL_REVIEW = Object.freeze({ status: "manual_review", topic: null, draft: null });

/** Returns the trimmed text, or null when input is not a usable non-empty string. */
export function parseInput(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { text } = body;
  if (typeof text !== "string" || text.trim() === "") return null;
  return text;
}

/**
 * Validates raw model output. The model is untrusted: it may return non-JSON,
 * an unknown topic, an empty draft or extra fields. Only a whitelisted shape passes.
 * Returns { ok: true, value } or { ok: false, reason }.
 */
export function validateModelOutput(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "not_string" };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not_object" };
  }
  const { topic, draft } = parsed;
  if (!ALLOWED_TOPICS.includes(topic)) return { ok: false, reason: "bad_topic" };
  if (typeof draft !== "string" || draft.trim() === "") return { ok: false, reason: "empty_draft" };
  return { ok: true, value: { topic, draft: draft.trim() } };
}

class ModelTimeoutError extends Error {
  constructor(ms) {
    super(`Model did not answer within ${ms} ms`);
    this.name = "ModelTimeoutError";
  }
}

/**
 * Calls the classifier with a hard deadline. The AbortSignal lets a cooperative
 * provider cancel its work; the race guarantees the deadline even if it ignores the signal.
 */
async function classifyWithDeadline(classify, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ModelTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  const call = Promise.resolve().then(() => classify(text, { signal: controller.signal }));
  call.catch(() => {}); // a late rejection after the deadline must not crash the process
  try {
    return await Promise.race([call, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Full triage: never throws. Returns { result, reason } where result is the public
 * response body and reason is an internal code for logs/metrics.
 */
export async function triage(text, { classify, timeoutMs = MODEL_TIMEOUT_MS }) {
  let raw;
  try {
    raw = await classifyWithDeadline(classify, text, timeoutMs);
  } catch (error) {
    const reason = error instanceof ModelTimeoutError ? "timeout" : "provider_error";
    return { result: MANUAL_REVIEW, reason };
  }
  const checked = validateModelOutput(raw);
  if (!checked.ok) return { result: MANUAL_REVIEW, reason: checked.reason };
  return { result: { status: "ready", ...checked.value }, reason: "ok" };
}
