/**
 * Service worker: does the work the content script cannot do in the page.
 *
 * - Fetches published Google Docs. Content scripts are bound by the page's
 *   CORS rules, so the course page cannot read docs.google.com directly; the
 *   extension's host permission lets this worker do it.
 * - Recognizes text in document images (OCR) through the offscreen document
 *   (src/offscreen.html), which can run Tesseract's Web Worker.
 * - Reads document images as data URLs, so an exported HTML file can embed
 *   them.
 *
 * Requests are built here from validated inputs (a published-document id, an
 * image URL on Google Docs' image host), so the worker never acts as a
 * general-purpose proxy.
 */

const PUBLISHED_DOC_ID = /^[\w-]{20,200}$/;
const OFFSCREEN_URL = "src/offscreen.html";
/** Larger images are left as links in exports rather than embedded. */
const MAX_EMBEDDED_IMAGE_BYTES = 8 * 1024 * 1024;

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
function docImageUrl(src) {
  let url;
  try {
    url = new URL(src);
  } catch {
    url = null;
  }
  if (url?.protocol !== "https:" || url.hostname !== "docs.google.com" || !url.pathname.startsWith("/docs-images-rt/")) {
    throw new Error("Only images from Google Docs are supported.");
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
  const url = docImageUrl(src);
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ target: "offscreen", type: "ocr", url });
  if (!response?.ok) throw new Error(response?.error ?? "The text recognizer did not answer");
  return { text: response.text, code: response.code };
}

async function fetchImageAsDataUrl(src) {
  const response = await fetch(docImageUrl(src), { credentials: "omit" });
  if (!response.ok) throw new Error(`The image request failed with HTTP ${response.status}`);
  const type = response.headers.get("content-type")?.split(";")[0] ?? "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!type.startsWith("image/")) throw new Error("The response is not an image");
  if (bytes.length > MAX_EMBEDDED_IMAGE_BYTES) throw new Error("The image is too large to embed");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

const HANDLERS = {
  "fetch-published-doc": (message) => fetchPublishedDoc(message.docId).then((html) => ({ html })),
  "ocr-image": (message) => recognizeImage(message.src),
  "fetch-image": (message) => fetchImageAsDataUrl(message.src).then((dataUrl) => ({ dataUrl })),
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
