/**
 * Service worker: does the work the content script cannot do in the page.
 *
 * - Fetches published Google Docs. Content scripts are bound by the page's
 *   CORS rules, so the course page cannot read docs.google.com directly; the
 *   extension's host permission lets this worker do it.
 * - Recognizes text in document images (OCR) through the offscreen document
 *   (src/offscreen.html), which can run Tesseract's Web Worker.
 *
 * Requests are built here from validated inputs (a published-document id, an
 * image URL on Google Docs' image host), so the worker never acts as a
 * general-purpose proxy.
 */

const PUBLISHED_DOC_ID = /^[\w-]{20,200}$/;
const OFFSCREEN_URL = "src/offscreen.html";

async function fetchPublishedDoc(docId) {
  if (typeof docId !== "string" || !PUBLISHED_DOC_ID.test(docId)) {
    throw new Error("Invalid published document id");
  }
  const url = `https://docs.google.com/document/d/e/${docId}/pub?embedded=true`;
  const response = await fetch(url, { credentials: "omit", cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Google Docs responded with HTTP ${response.status}`);
  }
  return response.text();
}

/** Images in published Docs are served from docs.google.com/docs-images-rt/. */
function ocrImageUrl(src) {
  let url;
  try {
    url = new URL(src);
  } catch {
    url = null;
  }
  if (url?.protocol !== "https:" || url.hostname !== "docs.google.com" || !url.pathname.startsWith("/docs-images-rt/")) {
    throw new Error("Text recognition only works on images from Google Docs.");
  }
  return url.href;
}

let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length > 0) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WORKERS"],
      justification: "Run Tesseract OCR, which needs a Web Worker, on document images.",
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

async function recognizeImage(src) {
  const url = ocrImageUrl(src);
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ target: "offscreen", type: "ocr", url });
  if (!response?.ok) throw new Error(response?.error ?? "The text recognizer did not answer");
  return { text: response.text, code: response.code };
}

const HANDLERS = {
  "fetch-published-doc": (message) => fetchPublishedDoc(message.docId).then((html) => ({ html })),
  "ocr-image": (message) => recognizeImage(message.src),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message?.target === undefined && HANDLERS[message?.type];
  if (!handler) return false;
  handler(message).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }),
  );
  return true; // Keep the channel open for the async response.
});
