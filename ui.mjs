// Page rendering logic, kept DOM-light so it can be unit-tested in Node with a tiny fake document.

const TOPIC_LABELS = { delivery: "Доставка", pricing: "Цена", other: "Другое" };

export const MANUAL_REVIEW_TITLE = "Нужен ручной разбор";

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  node.textContent = text; // model output is never inserted as HTML
  return node;
}

/** Called the moment a request is sent: the previous draft must not stay on screen. */
export function clearResult(container) {
  container.className = "";
  container.replaceChildren();
}

/** Replaces the whole result block for a server reply. Nothing from a previous reply survives. */
export function renderReply(container, httpStatus, body, doc = container.ownerDocument) {
  const show = (kind, ...nodes) => {
    container.className = kind;
    container.replaceChildren(...nodes);
  };
  if (body?.status === "ready") {
    show("ready",
      el(doc, "div", "label", "Тема"),
      el(doc, "strong", "", TOPIC_LABELS[body.topic] ?? body.topic),
      el(doc, "div", "label", "Черновик ответа"),
      el(doc, "p", "draft", body.draft));
  } else if (body?.status === "manual_review") {
    show("manual",
      el(doc, "strong", "", MANUAL_REVIEW_TITLE),
      el(doc, "p", "", "AI не смог надёжно обработать заявку. Определите тему и напишите ответ вручную."));
  } else if (body?.status === "invalid_input") {
    show("error", el(doc, "p", "", "Введите текст обращения."));
  } else {
    show("error", el(doc, "p", "", `Сервис недоступен (HTTP ${httpStatus}). Попробуйте ещё раз.`));
  }
}
