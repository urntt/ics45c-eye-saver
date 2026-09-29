/**
 * Content script: swaps the course page's nested-iframe document for a reader
 * view rendered natively into the page.
 *
 * Course pages embed a published Google Doc through three nested iframes in a
 * fixed-height tile, which leaves a small inner scroll box. This script reads
 * the embed code from the page, asks the service worker for the published
 * document, converts it with `Ics45cConverter` and shows it in a shadow-DOM
 * reader (course navigation, article, on-page contents) that scrolls with the
 * page itself. Pages that contain anything besides supported embeds (such as
 * the home page) are left untouched.
 */
(() => {
  "use strict";

  const SITE_ROOT = "/view/45c-programming-in-cpp";
  const HOST_ID = "ics45c-reader";
  const PUBLISHED_DOC = /^https:\/\/docs\.google\.com\/document\/d\/e\/([\w-]+)\/pub(?:[?#]|$)/;
  const FRAME_HOSTS = new Set(["docs.google.com", "drive.google.com"]);
  const THEME_MODES = ["auto", "light", "dark"];
  const THEME_LABELS = { auto: "Theme: follow system", light: "Theme: light", dark: "Theme: dark" };

  const root = document.documentElement;

  // ---------------------------------------------------------------------------
  // Page state: `data-ics45c` on <html> is "pending" while the script decides,
  // "active" while the reader replaces the Sites UI, and absent otherwise.

  function injectPageStyle() {
    const style = document.createElement("style");
    style.textContent = `
      html[data-ics45c="pending"] body { visibility: hidden !important; }
      html[data-ics45c="active"] { background: var(--ics45c-bg) !important; }
      html[data-ics45c="active"] body {
        margin: 0 !important; overflow: visible !important; height: auto !important;
        min-height: 100vh !important; background: transparent !important;
      }
      html[data-ics45c="active"] body > :not(#${HOST_ID}) { display: none !important; }
      #${HOST_ID} { all: initial !important; display: block !important; }
    `;
    root.append(style);
  }

  function setPageState(state) {
    if (state) root.setAttribute("data-ics45c", state);
    else root.removeAttribute("data-ics45c");
  }

  function onReady(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
    } else {
      callback();
    }
  }

  // ---------------------------------------------------------------------------
  // Reading the Sites page

  function embedSource(code) {
    const iframe = new DOMParser().parseFromString(code ?? "", "text/html").querySelector("iframe[src]");
    return iframe?.getAttribute("src") ?? null;
  }

  function classifyEmbed(src) {
    let url;
    try {
      url = new URL(src);
    } catch {
      return null;
    }
    if (url.protocol !== "https:") return null;
    const published = PUBLISHED_DOC.exec(url.href);
    if (published) {
      return {
        kind: "doc",
        docId: published[1],
        openUrl: `https://docs.google.com/document/d/e/${published[1]}/pub`,
      };
    }
    if (FRAME_HOSTS.has(url.hostname)) return { kind: "frame", src: url.href, openUrl: url.href };
    return null;
  }

  /** True when a section holds text or media outside the embed tiles. */
  function hasContentOutside(tiles) {
    const insideTile = (node) => tiles.some((tile) => tile.contains(node));
    for (const section of document.querySelectorAll("section")) {
      const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (node.data.trim() && !parent.closest("script, style") && !insideTile(node)) return true;
      }
      for (const media of section.querySelectorAll("img, iframe, video")) {
        if (!insideTile(media)) return true;
      }
    }
    return false;
  }

  /** Returns the page's embeds, or null when the page is not a pure doc page. */
  function findEmbeds() {
    const tiles = [...document.querySelectorAll("section [data-code]")];
    if (tiles.length === 0) return null;
    const embeds = [];
    for (const tile of tiles) {
      const src = embedSource(tile.getAttribute("data-code"));
      const embed = src && classifyEmbed(src);
      if (!embed) return null;
      embeds.push(embed);
    }
    return hasContentOutside(tiles) ? null : embeds;
  }

  function normalizePath(pathname) {
    return pathname.replace(/\/+$/, "");
  }

  function readNavItem(li) {
    const level = Number(li.dataset.navLevel);
    const link = li.querySelector("a[data-level]");
    const href = link?.getAttribute("href");
    const url = href ? new URL(href, location.origin) : null;
    const children = [...li.querySelectorAll(`li[data-nav-level="${level + 1}"]`)]
      .filter((child) => child.parentElement.closest("li[data-nav-level]") === li)
      .map(readNavItem);
    return {
      title: link?.textContent.trim() ?? "",
      href: url?.href ?? null,
      current: !!url && normalizePath(url.pathname) === normalizePath(location.pathname),
      children,
    };
  }

  /** Course navigation tree, read from the Sites header. */
  function readSiteNav() {
    const nav = [...document.querySelectorAll("nav")].find((n) => n.querySelector('li[data-nav-level="1"]'));
    if (!nav) return [];
    const seen = new Set();
    return [...nav.querySelectorAll('li[data-nav-level="1"]')].map(readNavItem).filter((item) => {
      const key = `${item.title}|${item.href}`;
      if (!item.title || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function findCurrent(items) {
    for (const item of items) {
      if (item.current) return item;
      const child = findCurrent(item.children);
      if (child) return child;
    }
    return null;
  }

  function readTitles(nav) {
    const [siteTitle, ...rest] = document.title.split(" - ");
    return {
      siteTitle: siteTitle.trim() || "Course",
      pageTitle: findCurrent(nav)?.title ?? (rest.join(" - ").trim() || siteTitle.trim()),
    };
  }

  // ---------------------------------------------------------------------------
  // DOM helpers

  function h(tag, attributes = {}, ...children) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (value === null || value === undefined || value === false) continue;
      if (name === "className") element.className = value;
      else if (name === "text") element.textContent = value;
      else element.setAttribute(name, value === true ? "" : value);
    }
    element.append(...children.flat().filter(Boolean));
    return element;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    menu: [["path", { d: "M4 6h16M4 12h16M4 18h16" }]],
    sun: [
      ["circle", { cx: 12, cy: 12, r: 4 }],
      ["path", { d: "M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" }],
    ],
    moon: [["path", { d: "M20.5 14.1A8.5 8.5 0 0 1 9.9 3.5 8.5 8.5 0 1 0 20.5 14.1z" }]],
    auto: [
      ["circle", { cx: 12, cy: 12, r: 9 }],
      ["path", { d: "M12 3a9 9 0 0 1 0 18z", fill: "currentColor" }],
    ],
    external: [["path", { d: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" }]],
    page: [["path", { d: "M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5" }]],
    book: [["path", { d: "M3 5h6a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H3zM21 5h-6a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h7z" }]],
    copy: [
      ["rect", { x: 9, y: 9, width: 11, height: 11, rx: 2 }],
      ["path", { d: "M5 15V5a2 2 0 0 1 2-2h10" }],
    ],
    check: [["path", { d: "M5 12.5l4.5 4.5L19 7.5" }]],
  };

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [key, value] of Object.entries({
      viewBox: "0 0 24 24", width: 18, height: 18, fill: "none", stroke: "currentColor",
      "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
    })) {
      svg.setAttribute(key, value);
    }
    for (const [tag, attributes] of ICONS[name]) {
      const shape = document.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);
      svg.append(shape);
    }
    return svg;
  }

  // ---------------------------------------------------------------------------
  // Documents

  async function renderEmbed(embed, pageTitle) {
    if (embed.kind === "frame") {
      return h("iframe", {
        className: "embed-frame",
        src: embed.src,
        title: pageTitle,
        allow: "fullscreen",
      });
    }
    const response = await chrome.runtime.sendMessage({ type: "fetch-published-doc", docId: embed.docId });
    if (!response?.ok) throw new Error(response?.error ?? "The extension did not answer");
    const source = new DOMParser().parseFromString(response.html, "text/html");
    return Ics45cConverter.convert(source, document, { siteOrigin: `${location.origin}${SITE_ROOT}` });
  }

  // ---------------------------------------------------------------------------
  // Reader

  class Reader {
    constructor({ embeds, nav, titles, themeMode }) {
      this.embeds = embeds;
      this.nav = nav;
      this.titles = titles;
      this.themeMode = themeMode;
      this.headings = [];
      this.scrollFrame = 0;
      this.colorScheme = matchMedia("(prefers-color-scheme: dark)");
    }

    /** Builds the shadow DOM and resolves once its stylesheet has loaded. */
    async mount() {
      this.host = h("div", { id: HOST_ID });
      this.shadow = this.host.attachShadow({ mode: "open" });
      const stylesheet = h("link", { rel: "stylesheet", href: chrome.runtime.getURL("src/reader.css") });
      const loaded = new Promise((resolve, reject) => {
        stylesheet.addEventListener("load", resolve, { once: true });
        stylesheet.addEventListener("error", () => reject(new Error("Could not load reader.css")), { once: true });
      });

      this.article = h("article", { className: "doc" });
      this.tocList = h("ul", { className: "toc-list" });
      this.toc = h("aside", { className: "toc", "aria-label": "On this page", hidden: true },
        h("div", { className: "toc-title", text: "On this page" }),
        this.tocList,
      );
      this.themeButton = h("button", { className: "tool icon-only", type: "button", "data-action": "theme" });
      this.menuButton = h("button", {
        className: "tool icon-only menu-btn", type: "button", "data-action": "menu",
        "aria-label": "Course pages", "aria-expanded": "false",
      }, icon("menu"));

      const single = this.embeds.length === 1 ? this.embeds[0] : null;
      this.app = h("div", { className: "app" },
        h("header", { className: "topbar" },
          this.menuButton,
          h("a", { className: "brand", href: `${location.origin}${SITE_ROOT}` }, this.titles.siteTitle),
          h("span", { className: "crumb-sep", "aria-hidden": "true", text: "/" }),
          h("span", { className: "crumb", text: this.titles.pageTitle }),
          h("div", { className: "spacer" }),
          single && h("a", {
            className: "tool", href: single.openUrl, target: "_blank", rel: "noopener noreferrer",
            title: "Open the source document in a new tab",
          }, icon("external"), h("span", { className: "label", text: "Source" })),
          h("button", {
            className: "tool", type: "button", "data-action": "original",
            title: "Show the original Google Sites page",
          }, icon("page"), h("span", { className: "label", text: "Original" })),
          this.themeButton,
        ),
        h("div", { className: "layout" },
          h("nav", { className: "sidebar", "aria-label": "Course pages" },
            h("div", { className: "sidebar-title", text: "Course" }),
            this.renderNav(this.nav),
          ),
          h("main", { className: "main" }, this.article),
          this.toc,
        ),
        h("div", { className: "backdrop", "data-action": "menu" }),
      );
      this.restoreButton = h("button", {
        className: "restore", type: "button", "data-action": "reader",
      }, icon("book"), h("span", { text: "Reader view" }));
      this.frame = h("div", { className: "root" }, this.app, this.restoreButton);

      this.shadow.append(stylesheet, this.frame);
      this.applyTheme();
      this.bindEvents();
      document.body.append(this.host);
      await loaded;
      this.applyTheme(); // Re-read colors now that the stylesheet is active.
    }

    renderNav(items) {
      const list = h("ul", { className: "nav-tree" });
      for (const item of items) {
        if (item.children.length) {
          const open = item.current || !!findCurrent(item.children);
          const summary = item.href
            ? h("a", { className: "nav-link", href: item.href, "aria-current": item.current ? "page" : null }, item.title)
            : h("span", { className: "nav-group", text: item.title });
          list.append(h("li", {},
            h("details", { open }, h("summary", {}, summary), this.renderNav(item.children)),
          ));
        } else {
          list.append(h("li", {},
            h("a", { className: "nav-link", href: item.href, "aria-current": item.current ? "page" : null }, item.title),
          ));
        }
      }
      return list;
    }

    bindEvents() {
      this.shadow.addEventListener("click", (event) => this.onClick(event));
      window.addEventListener("scroll", () => this.scheduleScrollSpy(), { passive: true });
      window.addEventListener("resize", () => this.scheduleScrollSpy(), { passive: true });
      window.addEventListener("popstate", (event) => this.onPopState(event));
      this.colorScheme.addEventListener("change", () => this.applyTheme());
    }

    onClick(event) {
      const actionTarget = event.target.closest("[data-action]");
      if (actionTarget) {
        const action = actionTarget.getAttribute("data-action");
        if (action === "theme") this.cycleTheme();
        else if (action === "menu") this.toggleMenu();
        else if (action === "original") this.deactivate();
        else if (action === "reader") this.activate();
        else if (action === "retry") this.load();
        else if (action === "copy") this.copyCode(actionTarget);
        return;
      }
      const link = event.target.closest('a[href^="#"]');
      if (link) this.followAnchor(event, link);
      else if (event.target.closest(".sidebar a")) this.toggleMenu(false);
    }

    followAnchor(event, link) {
      const id = decodeURIComponent(link.getAttribute("href").slice(1));
      const target = id && this.shadow.getElementById(id);
      if (!target) return;
      event.preventDefault();
      history.replaceState({ ...history.state, ics45cScrollY: window.scrollY }, "");
      history.pushState({ ics45cAnchor: id }, "", `#${encodeURIComponent(id)}`);
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    onPopState(event) {
      if (!this.isActive) return;
      const scrollY = event.state?.ics45cScrollY;
      if (typeof scrollY === "number") window.scrollTo({ top: scrollY });
      else this.scrollToHash();
    }

    scrollToHash() {
      const id = decodeURIComponent(location.hash.slice(1));
      const target = id && this.shadow.getElementById(id);
      if (target) target.scrollIntoView({ block: "start" });
    }

    get isActive() {
      return this.host.hasAttribute("data-active");
    }

    activate() {
      this.host.setAttribute("data-active", "");
      setPageState("active");
      window.scrollTo({ top: 0 });
      this.scheduleScrollSpy();
    }

    deactivate() {
      this.toggleMenu(false);
      this.host.removeAttribute("data-active");
      setPageState(null);
      window.scrollTo({ top: 0 });
    }

    toggleMenu(open = !this.app.classList.contains("nav-open")) {
      this.app.classList.toggle("nav-open", open);
      this.menuButton.setAttribute("aria-expanded", String(open));
    }

    // Theme -------------------------------------------------------------------

    cycleTheme() {
      this.themeMode = THEME_MODES[(THEME_MODES.indexOf(this.themeMode) + 1) % THEME_MODES.length];
      chrome.storage.local.set({ theme: this.themeMode });
      this.applyTheme();
    }

    applyTheme() {
      const resolved = this.themeMode === "auto" ? (this.colorScheme.matches ? "dark" : "light") : this.themeMode;
      this.frame.dataset.theme = resolved;
      this.themeButton.replaceChildren(icon({ auto: "auto", light: "sun", dark: "moon" }[this.themeMode]));
      this.themeButton.title = THEME_LABELS[this.themeMode];
      this.themeButton.setAttribute("aria-label", THEME_LABELS[this.themeMode]);
      root.style.colorScheme = resolved;
      const background = getComputedStyle(this.frame).getPropertyValue("--bg").trim();
      if (background) root.style.setProperty("--ics45c-bg", background);
    }

    // Content -----------------------------------------------------------------

    async load() {
      this.article.replaceChildren(this.renderSkeleton());
      this.toc.hidden = true;
      try {
        const parts = await Promise.all(this.embeds.map((embed) => renderEmbed(embed, this.titles.pageTitle)));
        this.article.replaceChildren(...parts);
        this.decorateCodeBlocks();
        this.buildToc();
        if (location.hash) this.scrollToHash();
      } catch (error) {
        console.error("[ICS 45C Eye Saver]", error);
        this.article.replaceChildren(this.renderError(error));
      }
    }

    renderSkeleton() {
      const widths = [38, 92, 86, 95, 60, 0, 88, 94, 72, 0, 90, 83, 45];
      return h("div", { className: "skeleton", role: "status", "aria-label": "Loading document" },
        widths.map((width) => h("span", { style: width ? `width:${width}%` : "visibility:hidden" })),
      );
    }

    renderError(error) {
      return h("div", { className: "load-error", role: "alert" },
        h("p", { className: "load-error-title", text: "Could not load this document." }),
        h("p", { className: "load-error-detail", text: String(error?.message ?? error) }),
        h("div", { className: "load-error-actions" },
          h("button", { className: "tool", type: "button", "data-action": "retry", text: "Retry" }),
          h("button", { className: "tool", type: "button", "data-action": "original", text: "Show original page" }),
        ),
      );
    }

    decorateCodeBlocks() {
      for (const pre of this.article.querySelectorAll("pre")) {
        const code = pre.querySelector("code");
        const language = /\blanguage-(\w+)\b/.exec(code?.className ?? "")?.[1];
        // highlight.js escapes its input, so its HTML output is safe to insert.
        if (language) code.innerHTML = Ics45cHighlight.highlight(code.textContent, language);
        const button = h("button", {
          className: "copy-btn", type: "button", "data-action": "copy", title: "Copy", "aria-label": "Copy code",
        }, icon("copy"));
        const block = h("div", { className: "code-block" });
        pre.replaceWith(block);
        block.append(pre, button);
      }
    }

    async copyCode(button) {
      const code = button.parentElement.querySelector("pre").textContent;
      try {
        await navigator.clipboard.writeText(code);
        button.replaceChildren(icon("check"));
        button.classList.add("copied");
      } catch (error) {
        console.error("[ICS 45C Eye Saver] copy failed", error);
        return;
      }
      setTimeout(() => {
        button.replaceChildren(icon("copy"));
        button.classList.remove("copied");
      }, 1500);
    }

    // On-page contents ----------------------------------------------------------

    buildToc() {
      this.headings = [...this.article.querySelectorAll("h1, h2, h3")].filter((heading) => heading.textContent.trim());
      this.tocList.replaceChildren();
      if (this.headings.length < 2) return;
      const minLevel = Math.min(...this.headings.map((heading) => Number(heading.tagName[1])));
      this.headings.forEach((heading, index) => {
        heading.id ||= `section-${index + 1}`;
        this.tocList.append(h("li", { className: `level-${Number(heading.tagName[1]) - minLevel}` },
          h("a", { href: `#${encodeURIComponent(heading.id)}`, "data-heading": heading.id }, heading.textContent.trim()),
        ));
      });
      this.toc.hidden = false;
      this.scheduleScrollSpy();
    }

    scheduleScrollSpy() {
      if (this.scrollFrame || !this.headings.length) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = 0;
        this.updateScrollSpy();
      });
    }

    updateScrollSpy() {
      const offset = this.app.querySelector(".topbar").offsetHeight + 24;
      let active = this.headings[0];
      for (const heading of this.headings) {
        if (heading.getBoundingClientRect().top - offset > 0) break;
        active = heading;
      }
      for (const link of this.tocList.querySelectorAll("a")) {
        const current = link.dataset.heading === active.id;
        link.toggleAttribute("aria-current", current);
        if (current) this.keepVisible(link);
      }
    }

    /** Scrolls the contents panel (not the page) so the active entry stays visible. */
    keepVisible(link) {
      const panel = this.toc;
      const top = link.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
      if (top < panel.scrollTop + 40) panel.scrollTop = Math.max(0, top - 40);
      else if (top + link.offsetHeight > panel.scrollTop + panel.clientHeight - 40) {
        panel.scrollTop = top + link.offsetHeight - panel.clientHeight + 40;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Entry point

  async function start() {
    const embeds = findEmbeds();
    if (!embeds) return;
    const nav = readSiteNav();
    const { theme } = await chrome.storage.local.get({ theme: "auto" });
    const reader = new Reader({
      embeds,
      nav,
      titles: readTitles(nav),
      themeMode: THEME_MODES.includes(theme) ? theme : "auto",
    });
    await reader.mount();
    reader.activate();
    await reader.load();
  }

  if (root.hasAttribute("data-ics45c")) return; // Already injected into this page.
  injectPageStyle();
  setPageState("pending");
  const failsafe = setTimeout(() => {
    if (root.getAttribute("data-ics45c") === "pending") setPageState(null);
  }, 5000);

  onReady(() => {
    start()
      .catch((error) => {
        console.error("[ICS 45C Eye Saver]", error);
        document.getElementById(HOST_ID)?.remove();
        setPageState(null);
      })
      .finally(() => {
        clearTimeout(failsafe);
        if (root.getAttribute("data-ics45c") === "pending") setPageState(null);
      });
  });
})();
