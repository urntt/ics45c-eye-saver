/**
 * Offscreen document: runs OCR (Tesseract.js) for the reader's "Copy text"
 * button on images.
 *
 * Tesseract needs a Web Worker and WebAssembly. A content script cannot start
 * an extension worker inside the course page, and the service worker cannot
 * start workers at all, so background.js opens this hidden extension page on
 * demand and forwards requests to it. The engine and the English model load
 * from the extension package (vendor/tesseract/); nothing is downloaded.
 * Ics45cOcrLayout (ocr-layout.js) then restores the layout of code
 * screenshots from the word positions.
 *
 * The Tesseract worker holds the model in memory, so it is terminated after a
 * few idle minutes and recreated on the next request.
 */

const IDLE_TIMEOUT_MS = 3 * 60 * 1000;
/** Tesseract does not reject when its engine fails to start, so bound each job. */
const JOB_TIMEOUT_MS = 60 * 1000;
const VENDOR = chrome.runtime.getURL("vendor/tesseract/");

let workerPromise = null;
let pending = 0;
let idleTimer = 0;

function getWorker() {
  workerPromise ??= Tesseract.createWorker("eng", Tesseract.OEM.LSTM_ONLY, {
    workerPath: `${VENDOR}worker.min.js`,
    corePath: `${VENDOR}tesseract-core-simd-lstm.js`,
    langPath: `${VENDOR}lang`,
    workerBlobURL: false,
    cacheMethod: "none",
  }).catch((error) => {
    workerPromise = null;
    throw error;
  });
  return workerPromise;
}

async function releaseWorker() {
  const worker = workerPromise;
  workerPromise = null;
  await (await worker)?.terminate();
}

async function recognizeImage(url) {
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) throw new Error(`The image request failed with HTTP ${response.status}`);
  const image = await response.blob();
  const worker = await getWorker();
  const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
  return Ics45cOcrLayout.format(data);
}

/**
 * Recognizes the text of an image URL (already validated by background.js).
 * @returns {Promise<{text: string, code: boolean}>}
 */
async function recognize(url) {
  pending++;
  clearTimeout(idleTimer);
  let timer = 0;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Text recognition timed out")), JOB_TIMEOUT_MS);
  });
  try {
    return await Promise.race([recognizeImage(url), timeout]);
  } catch (error) {
    releaseWorker(); // Start from a fresh engine next time.
    throw error;
  } finally {
    clearTimeout(timer);
    if (--pending === 0) idleTimer = setTimeout(releaseWorker, IDLE_TIMEOUT_MS);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen" || message.type !== "ocr") return false;
  recognize(message.url).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }),
  );
  return true; // Keep the channel open for the async response.
});
