import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.mjs";
import { validateModelOutput, triage, MANUAL_REVIEW } from "../triage.mjs";

const MANUAL = { status: "manual_review", topic: null, draft: null };

async function startServer(options) {
  const server = createApp(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

async function post(url, rawBody) {
  const reply = await fetch(`${url}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });
  return { status: reply.status, body: await reply.json() };
}

describe("POST /api/triage with the issued mock", () => {
  let ctx;
  before(async () => { ctx = await startServer(); });
  after(() => ctx.server.close());

  const send = (body) => post(ctx.url, JSON.stringify(body));

  test("valid model answer -> ready with topic and draft", async () => {
    assert.deepEqual(await send({ text: "Когда будет доставка?" }), {
      status: 200,
      body: { status: "ready", topic: "delivery", draft: "Спасибо за обращение. Уточним детали заявки." },
    });
    assert.equal((await send({ text: "Какая цена?" })).body.topic, "pricing");
    assert.equal((await send({ text: "Привет" })).body.topic, "other");
  });

  for (const [name, raw] of [
    ["missing text", JSON.stringify({})],
    ["empty text", JSON.stringify({ text: "" })],
    ["whitespace-only text", JSON.stringify({ text: "   \n\t" })],
    ["number text", JSON.stringify({ text: 42 })],
    ["null text", JSON.stringify({ text: null })],
    ["array body", JSON.stringify(["text"])],
    ["null body", "null"],
    ["broken JSON", "{\"text\": "],
    ["empty body", ""],
  ]) {
    test(`invalid input: ${name} -> 400 invalid_input`, async () => {
      assert.deepEqual(await post(ctx.url, raw), { status: 400, body: { status: "invalid_input" } });
    });
  }

  for (const tag of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    test(`model failure ${tag} -> 200 manual_review`, async () => {
      assert.deepEqual(await send({ text: `Где доставка? ${tag}` }), { status: 200, body: MANUAL });
    });
  }

  test("model timeout -> manual_review within the 300 ms budget", async () => {
    const startedAt = performance.now();
    const reply = await send({ text: "Где заказ? [timeout]" });
    const elapsed = performance.now() - startedAt;
    assert.deepEqual(reply, { status: 200, body: MANUAL });
    assert.ok(elapsed >= 290 && elapsed < 700, `answered in ${Math.round(elapsed)} ms`);
  });

  test("oversized body -> 413", async () => {
    const reply = await post(ctx.url, JSON.stringify({ text: "x".repeat(20_000) }));
    assert.equal(reply.status, 413);
  });

  test("GET / serves the page, unknown route -> 404", async () => {
    const page = await fetch(`${ctx.url}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /from "\/ui\.mjs"/);
    const script = await fetch(`${ctx.url}/ui.mjs`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /javascript/);
    assert.equal((await fetch(`${ctx.url}/nope`)).status, 404);
  });
});

describe("triage() with stub providers", () => {
  test("deadline holds even if the provider ignores AbortSignal", async () => {
    const slowDeaf = () => new Promise((resolve) => setTimeout(() => resolve('{"topic":"other","draft":"late"}'), 1000).unref());
    const startedAt = performance.now();
    const { result, reason } = await triage("x", { classify: slowDeaf, timeoutMs: 50 });
    assert.deepEqual(result, MANUAL_REVIEW);
    assert.equal(reason, "timeout");
    assert.ok(performance.now() - startedAt < 300);
  });

  test("provider receives an AbortSignal that fires on timeout", async () => {
    let seen;
    const hang = (_text, { signal }) => { seen = signal; return new Promise(() => {}); };
    await triage("x", { classify: hang, timeoutMs: 20 });
    assert.equal(seen.aborted, true);
  });

  test("synchronous throw from provider -> manual_review, not a crash", async () => {
    const { result, reason } = await triage("x", { classify: () => { throw new Error("boom"); } });
    assert.deepEqual(result, MANUAL_REVIEW);
    assert.equal(reason, "provider_error");
  });
});

describe("validateModelOutput()", () => {
  const cases = [
    ['{"topic":"pricing","draft":"Ок"}', true],
    ['{"topic":"pricing","draft":"Ок","extra":"<script>"}', true],
    ['{"topic":"refund","draft":"Ок"}', false],
    ['{"topic":"pricing","draft":"  "}', false],
    ['{"topic":"pricing","draft":123}', false],
    ['{"topic":"pricing"}', false],
    ['["pricing","Ок"]', false],
    ["null", false],
    ["not json", false],
  ];
  for (const [raw, ok] of cases) {
    test(`${raw} -> ${ok ? "accepted" : "rejected"}`, () => {
      const checked = validateModelOutput(raw);
      assert.equal(checked.ok, ok);
      if (ok) assert.deepEqual(Object.keys(checked.value), ["topic", "draft"]);
    });
  }
});
