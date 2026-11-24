import { test } from "node:test";
import assert from "node:assert/strict";
import { clearResult, renderReply, MANUAL_REVIEW_TITLE } from "../ui.mjs";

// Minimal DOM stand-in: enough for createElement / textContent / replaceChildren.
class FakeNode {
  constructor(tag) { this.tag = tag; this.className = ""; this.children = []; this._text = ""; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  replaceChildren(...nodes) { this._text = ""; this.children = nodes; }
}
const fakeDocument = { createElement: (tag) => new FakeNode(tag) };
const newContainer = () => { const c = new FakeNode("div"); c.ownerDocument = fakeDocument; return c; };

const READY = { status: "ready", topic: "delivery", draft: "Спасибо за обращение. Уточним детали заявки." };
const MANUAL = { status: "manual_review", topic: null, draft: null };

test("ready reply shows topic and draft", () => {
  const result = newContainer();
  renderReply(result, 200, READY);
  assert.equal(result.className, "ready");
  assert.match(result.textContent, /Доставка/);
  assert.match(result.textContent, /Уточним детали заявки/);
});

test("manual_review after a ready reply removes the previous draft", () => {
  const result = newContainer();
  renderReply(result, 200, READY);
  renderReply(result, 200, MANUAL);
  assert.equal(result.className, "manual");
  assert.match(result.textContent, new RegExp(MANUAL_REVIEW_TITLE));
  assert.doesNotMatch(result.textContent, /Уточним детали заявки/);
  assert.equal(result.children.some((n) => n.className === "draft"), false);
});

test("clearResult wipes the old draft before the next answer arrives", () => {
  const result = newContainer();
  renderReply(result, 200, READY);
  clearResult(result);
  assert.equal(result.textContent, "");
  assert.equal(result.className, "");
});

test("server and network errors also never keep the old draft", () => {
  for (const [status, body] of [[400, { status: "invalid_input" }], [500, { status: "server_error" }], [0, null]]) {
    const result = newContainer();
    renderReply(result, 200, READY);
    renderReply(result, status, body);
    assert.equal(result.className, "error");
    assert.doesNotMatch(result.textContent, /Уточним детали заявки/);
  }
});

test("model text is rendered as text, not HTML", () => {
  const result = newContainer();
  renderReply(result, 200, { ...READY, draft: "<img src=x onerror=alert(1)>" });
  const draft = result.children.find((n) => n.className === "draft");
  assert.equal(draft.textContent, "<img src=x onerror=alert(1)>");
  assert.equal(draft.children.length, 0);
});
