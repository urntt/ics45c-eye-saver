/**
 * Service worker: fetches published Google Docs on behalf of the content script.
 *
 * Content scripts are bound by the page's CORS rules, so the course page
 * cannot read docs.google.com directly. The extension's host permission lets
 * this worker do it. Only "Publish to the web" documents are fetched, and the
 * request is built here from a validated document id, so the worker never acts
 * as a general-purpose proxy.
 */

const PUBLISHED_DOC_ID = /^[\w-]{20,200}$/;

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "fetch-published-doc") {
    return false;
  }
  fetchPublishedDoc(message.docId).then(
    (html) => sendResponse({ ok: true, html }),
    (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }),
  );
  return true; // Keep the channel open for the async response.
});
