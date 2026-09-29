/**
 * Smoke test against the live course site.
 *
 * Launches a local Chrome in headless mode with the unpacked extension
 * installed, opens a few course pages and checks that the reader view
 * activates on document pages and stays away from other pages. Screenshots
 * go to ./smoke-output/ for a visual check.
 *
 * Usage: npm run smoke   (set CHROME_PATH to use a non-default Chrome binary)
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "smoke-output");
const SITE = "https://sites.google.com/view/45c-programming-in-cpp";
const DEFAULT_CHROME = {
  win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "/usr/bin/google-chrome",
};

const DOC_PAGES = ["homework-0", "syllabus", "course-info/assigned-reading"];
const PLAIN_PAGES = ["home"];
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

async function readerState(page) {
  return page.evaluate(() => {
    const host = document.getElementById("ics45c-reader");
    const shadow = host?.shadowRoot;
    return {
      pageState: document.documentElement.getAttribute("data-ics45c"),
      hasHost: !!host,
      blocks: shadow?.querySelector("article")?.children.length ?? 0,
      error: shadow?.querySelector(".load-error")?.textContent ?? null,
      tocEntries: shadow?.querySelectorAll(".toc-list li").length ?? 0,
    };
  });
}

async function waitForReader(page) {
  await page.waitForFunction(
    () => {
      const shadow = document.getElementById("ics45c-reader")?.shadowRoot;
      return shadow && !shadow.querySelector(".skeleton") && shadow.querySelector("article")?.children.length;
    },
    { timeout: 30000 },
  );
}

const reader = (selector) => `#ics45c-reader >>> ${selector}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until smooth scrolling and transitions have come to rest. */
async function settle(page) {
  let last = await page.evaluate(() => scrollY);
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const current = await page.evaluate(() => scrollY);
    if (current === last) break;
    last = current;
  }
  await sleep(300);
}

/** Exercises the reader's controls on one page. */
async function checkInteractions(browser, page) {
  const url = `${SITE}/homework-0`;
  await browser.defaultBrowserContext().overridePermissions("https://sites.google.com", ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
  await page.setViewport(VIEWPORTS.desktop);
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForReader(page);
  await page.evaluate(() => (window.__smokeMarker = true));

  // Contents link: smooth-scrolls to the heading and records history.
  const target = await page.$eval(reader(".toc-list li:nth-child(8) a"), (a) => a.dataset.heading);
  await page.locator(reader(".toc-list li:nth-child(8) a")).click();
  await settle(page);
  const afterJump = await page.evaluate(() => ({ y: scrollY, hash: decodeURIComponent(location.hash.slice(1)) }));
  const active = await page.$eval(reader(".toc-list a[aria-current]"), (a) => a.dataset.heading);
  check(afterJump.y > 500 && afterJump.hash === target, `contents link jumps to #${target}`);
  check(active === target, "scroll spy highlights the jumped-to heading");

  await page.goBack();
  await settle(page);
  const afterBack = await page.evaluate(() => ({ y: scrollY, hash: location.hash, marker: window.__smokeMarker }));
  check(afterBack.y < 50 && !afterBack.hash && afterBack.marker, "Back returns to the previous position without reloading");

  // Original page toggle and back.
  await page.locator(reader('[data-action="original"]')).click();
  const original = await page.evaluate(() => ({
    pageState: document.documentElement.getAttribute("data-ics45c"),
    sitesVisible: document.querySelector("section")?.getBoundingClientRect().height > 0,
  }));
  check(!original.pageState && original.sitesVisible, "Original shows the Google Sites page");
  await page.locator(reader(".restore")).click();
  check(
    (await page.evaluate(() => document.documentElement.getAttribute("data-ics45c"))) === "active",
    "Reader view button restores the reader",
  );

  // Syntax highlighting: code gets highlight.js spans, program output stays plain.
  const blocks = await page.$$eval(reader("pre code"), (codes) =>
    codes.map((code) => ({ language: code.className, spans: code.querySelectorAll('[class^="hljs-"]').length })),
  );
  check(
    blocks.some((block) => block.language === "language-cpp" && block.spans > 0) &&
      blocks.every((block) => block.language || block.spans === 0),
    `code blocks are highlighted (${blocks.filter((block) => block.spans).length}/${blocks.length}), output stays plain`,
  );

  // Copy button.
  await page.$eval(reader(".code-block"), (block) => block.scrollIntoView({ block: "center" }));
  await page.hover(reader(".code-block"));
  await page.locator(reader(".code-block .copy-btn")).click();
  await page.waitForSelector(reader(".copy-btn.copied"), { timeout: 3000 }).catch(() => null);
  const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  const expected = await page.$eval(reader(".code-block pre"), (pre) => pre.textContent);
  check(copied === expected, "copy button copies the code block");

  // Theme: auto -> light -> dark, persisted across reloads.
  await page.locator(reader('[data-action="theme"]')).click();
  await page.locator(reader('[data-action="theme"]')).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForReader(page);
  const theme = await page.$eval(reader(".root"), (root) => root.dataset.theme);
  const pageBackground = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  const readerBackground = await page.$eval(reader(".app"), (app) => getComputedStyle(app).backgroundColor);
  check(
    theme === "dark" && pageBackground === readerBackground,
    `dark theme persists across reloads (page background ${pageBackground})`,
  );
  await page.locator(reader('[data-action="theme"]')).click(); // Back to "auto".

  // Collapsed sidebar groups (Course Info) slide open instead of snapping.
  const groupHeight = () => page.$eval(reader(".sidebar details"), (group) => group.getBoundingClientRect().height);
  const closedHeight = await groupHeight();
  await page.locator(reader(".sidebar details > summary")).click();
  await sleep(90);
  const midHeight = await groupHeight();
  await sleep(400);
  const openHeight = await groupHeight();
  check(
    closedHeight < midHeight && midHeight < openHeight,
    `sidebar group animates open (${Math.round(closedHeight)} → ${Math.round(midHeight)} → ${Math.round(openHeight)}px)`,
  );

  // Mobile navigation drawer.
  await page.setViewport(VIEWPORTS.mobile);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForReader(page);
  const sidebarLeft = () => page.$eval(reader(".sidebar"), (nav) => Math.round(nav.getBoundingClientRect().left));
  const closedLeft = await sidebarLeft();
  await page.locator(reader(".menu-btn")).click();
  await settle(page);
  const openLeft = await sidebarLeft();
  await page.mouse.click(VIEWPORTS.mobile.width - 20, 400); // Backdrop.
  await settle(page);
  check(closedLeft < 0 && openLeft === 0 && (await sidebarLeft()) < 0, "mobile drawer opens and closes");
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? DEFAULT_CHROME[process.platform],
  headless: true,
  pipe: true,
  enableExtensions: true,
});

let failures = 0;
const check = (ok, message) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${message}`);
  if (!ok) failures++;
};

try {
  await browser.installExtension(ROOT);
  await mkdir(OUTPUT, { recursive: true });
  const page = await browser.newPage();

  for (const slug of DOC_PAGES) {
    for (const [name, viewport] of Object.entries(VIEWPORTS)) {
      for (const scheme of ["light", "dark"]) {
        await page.setViewport(viewport);
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
        await page.goto(`${SITE}/${slug}`, { waitUntil: "domcontentloaded" });
        await waitForReader(page);
        const state = await readerState(page);
        check(
          state.pageState === "active" && state.blocks > 5 && !state.error,
          `${slug} [${name}, ${scheme}] reader active with ${state.blocks} blocks, ${state.tocEntries} contents entries`,
        );
        await page.screenshot({ path: path.join(OUTPUT, `${slug.replaceAll("/", "_")}-${name}-${scheme}.png`) });
      }
    }
  }

  for (const slug of PLAIN_PAGES) {
    await page.setViewport(VIEWPORTS.desktop);
    await page.goto(`${SITE}/${slug}`, { waitUntil: "domcontentloaded" });
    // The content script decides right after DOMContentLoaded; give it a moment.
    await page.waitForFunction(() => document.documentElement.getAttribute("data-ics45c") !== "pending");
    await sleep(1500);
    const state = await readerState(page);
    check(!state.pageState && !state.hasHost, `${slug} left untouched`);
  }

  await checkInteractions(browser, page);
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} check(s) failed` : `\nAll checks passed. Screenshots: ${OUTPUT}`);
process.exitCode = failures ? 1 : 0;
