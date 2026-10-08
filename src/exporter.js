/**
 * Exports the reader's article as Markdown or as a standalone HTML file.
 *
 * Both formats are generated from the reader's own DOM (the output of
 * Ics45cConverter plus the reader's decorations), so an export contains what
 * the reader shows. Reader controls (copy and OCR buttons, OCR results) are
 * left out.
 *
 * Loaded as a classic content script (shares the global scope with
 * content.js) and as a CommonJS module by the Node test suite.
 */
const Ics45cExporter = (() => {
  "use strict";

  const READER_CONTROLS = "button, .ocr-panel";
  const BLOCK_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "PRE", "TABLE", "ASIDE", "NAV", "HR", "DIV", "IFRAME"]);
  /** GitHub-style alerts, which Obsidian also renders as callouts. */
  const CALLOUT_ALERTS = { "callout-warning": "WARNING", "callout-danger": "CAUTION", "callout-tip": "TIP" };

  /** A copy of the article without the reader's controls. */
  function contentOf(article) {
    const copy = article.cloneNode(true);
    for (const control of copy.querySelectorAll(READER_CONTROLS)) control.remove();
    return copy;
  }

  /** `ics45c-homework-0.md` for `/view/45c-programming-in-cpp/homework-0`. */
  function fileName(pathname, extension) {
    const segment = pathname.split("/").filter(Boolean).pop() ?? "";
    const slug = segment.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return `ics45c-${slug || "page"}.${extension}`;
  }

  // ---------------------------------------------------------------------------
  // Markdown

  function escapeText(text) {
    return text.replace(/[\\`*_~[\]<>]/g, "\\$&");
  }

  /** Escapes characters that would start a block (heading, list, ...) at a line start. */
  function escapeLineStarts(text) {
    return text.replace(/^(\s*)(#{1,6}(?=\s)|[-+](?=\s)|\d+(?=[.)]\s))/gm, (match, space, marker) =>
      /\d/.test(marker) ? `${space}${marker}\\` : `${space}\\${marker}`,
    );
  }

  /** Wraps content in markers, keeping surrounding whitespace outside them. */
  function wrap(content, open, close = open) {
    const [, before, inner, after] = /^(\s*)([\s\S]*?)(\s*)$/.exec(content);
    return inner ? `${before}${open}${inner}${close}${after}` : content;
  }

  function longestRun(text, character) {
    return Math.max(0, ...(text.match(new RegExp(`${character}+`, "g")) ?? []).map((run) => run.length));
  }

  function codeSpan(text) {
    const marks = "`".repeat(longestRun(text, "`") + 1);
    const pad = /^`|`$/.test(text) ? " " : "";
    return `${marks}${pad}${text}${pad}${marks}`;
  }

  function linkTo(anchor, ctx) {
    const text = inline(anchor, ctx);
    const href = anchor.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      const slug = ctx.anchors.get(decodeURIComponent(href.slice(1)));
      return slug ? `[${text}](#${slug})` : text;
    }
    const target = href.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20");
    return target ? `[${text}](${target})` : text;
  }

  function imageOf(img) {
    const alt = (img.getAttribute("alt") ?? "").replace(/[[\]]/g, "\\$&");
    return `![${alt}](${img.getAttribute("src")})`;
  }

  /** Markdown for the inline content of `node` (anything with childNodes). */
  function inline(node, ctx) {
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += escapeText(child.data.replace(/\s+/g, " "));
        continue;
      }
      if (child.nodeType !== 1) continue;
      switch (child.tagName) {
        case "STRONG":
          out += wrap(inline(child, ctx), "**");
          break;
        case "EM":
          out += wrap(inline(child, ctx), "*");
          break;
        case "S":
          out += wrap(inline(child, ctx), "~~");
          break;
        case "CODE":
          out += codeSpan(child.textContent);
          break;
        case "MARK":
        case "U":
        case "SUP":
        case "SUB": {
          const tag = child.tagName.toLowerCase();
          out += wrap(inline(child, ctx), `<${tag}>`, `</${tag}>`);
          break;
        }
        case "A":
          out += linkTo(child, ctx);
          break;
        case "IMG":
          out += imageOf(child);
          break;
        case "BR":
          out += ctx.lineBreak;
          break;
        default: // Wrappers without a Markdown equivalent (colored text, image frames).
          out += inline(child, ctx);
      }
    }
    return out;
  }

  function fenceOf(pre) {
    const code = pre.querySelector("code") ?? pre;
    const language = /\blanguage-(\w+)\b/.exec(code.getAttribute("class") ?? "")?.[1] ?? "";
    const text = code.textContent.replace(/\n+$/, "");
    const marks = "`".repeat(Math.max(3, longestRun(text, "`") + 1));
    return `${marks}${language}\n${text}\n${marks}`;
  }

  function listOf(list, ctx) {
    const ordered = list.tagName === "OL";
    const lines = [];
    let number = 1;
    for (const item of list.children) {
      if (item.tagName !== "LI") continue;
      if (ordered) number = Number(item.getAttribute("value")) || number;
      const marker = ordered ? `${number++}. ` : "- ";
      const [first = "", ...rest] = blocksOf(item, ctx).join("\n").split("\n");
      const indent = " ".repeat(marker.length);
      lines.push(marker + first, ...rest.map((line) => (line ? indent + line : line)));
    }
    return lines.join("\n");
  }

  /** A table cell on one line: blocks are joined with <br>, as GFM cells cannot span lines. */
  function cellOf(cell, ctx) {
    const parts = [];
    let run = [];
    const flush = () => {
      const text = inline({ childNodes: run }, ctx).trim();
      if (text) parts.push(text);
      run = [];
    };
    for (const node of cell.childNodes) {
      const pre = node.nodeType === 1 && (node.tagName === "PRE" ? node : node.querySelector?.(":scope > pre"));
      if (pre) {
        flush();
        parts.push(...pre.textContent.replace(/\n+$/, "").split("\n").map(codeSpan));
      } else if (node.nodeType === 1 && (node.tagName === "UL" || node.tagName === "OL")) {
        flush();
        parts.push(...[...node.querySelectorAll("li")].map((item) => `• ${inline(item, ctx).trim()}`));
      } else if (node.nodeType === 1 && BLOCK_TAGS.has(node.tagName)) {
        flush();
        const text = inline(node, ctx).trim();
        if (text) parts.push(text);
      } else {
        run.push(node);
      }
    }
    flush();
    return parts.join("<br>").replace(/\|/g, "\\|");
  }

  function tableOf(table, ctx) {
    const cellCtx = { ...ctx, lineBreak: "<br>" };
    const cellsOf = (row) => [...row.children].filter((cell) => /^T[DH]$/.test(cell.tagName)).map((cell) => cellOf(cell, cellCtx));
    const rows = [...table.querySelectorAll("tr")].filter((row) => row.closest("table") === table);
    const headerRows = rows.filter((row) => row.parentElement.tagName === "THEAD");
    const body = rows.filter((row) => !headerRows.includes(row)).map(cellsOf);
    const columns = Math.max(1, ...rows.map((row) => cellsOf(row).length));
    // GFM tables need a header row; tables without one get an empty header.
    const header = headerRows.length ? cellsOf(headerRows[0]) : [];
    const line = (cells) => `| ${Array.from({ length: columns }, (_, i) => cells[i] ?? "").join(" | ")} |`;
    return [line(header), line(Array(columns).fill("---")), ...body.map(line)].join("\n");
  }

  function calloutOf(aside, ctx) {
    const kind = Object.keys(CALLOUT_ALERTS).find((name) => aside.classList.contains(name));
    const lines = blocksOf(aside, ctx).join("\n\n").split("\n");
    return [`[!${CALLOUT_ALERTS[kind] ?? "NOTE"}]`, ...lines].map((text) => (text ? `> ${text}` : ">")).join("\n");
  }

  /** The document's own table of contents: one link per line, indented by level. */
  function contentsOf(nav, ctx) {
    return [...nav.querySelectorAll("li")]
      .map((item) => `${"  ".repeat(Math.round(parseFloat(item.style.paddingLeft) || 0))}- ${inline(item, ctx).trim()}`)
      .join("\n");
  }

  function blockOf(node, ctx) {
    const tag = node.tagName;
    if (tag === "P") {
      const text = inline(node, ctx).trim();
      if (!text) return [];
      if (node.classList.contains("doc-title")) return [`# ${text}`];
      if (node.classList.contains("doc-subtitle")) return [wrap(text, "*")];
      return [escapeLineStarts(text)];
    }
    if (/^H[1-6]$/.test(tag)) {
      const level = Math.min(6, Number(tag[1]) + ctx.headingOffset);
      return [`${"#".repeat(level)} ${inline(node, ctx).trim()}`];
    }
    if (tag === "UL" || tag === "OL") return [listOf(node, ctx)];
    if (tag === "PRE") return [fenceOf(node)];
    if (tag === "TABLE") return [tableOf(node, ctx)];
    if (tag === "ASIDE") return [calloutOf(node, ctx)];
    if (tag === "NAV") return [contentsOf(node, ctx)];
    if (tag === "HR") return ["---"];
    if (tag === "IFRAME") return [`[Embedded file](${node.getAttribute("src")})`];
    return blocksOf(node, ctx); // DIV wrappers (code-block, table-wrap).
  }

  /** Markdown blocks for a container that may mix inline content and block elements. */
  function blocksOf(container, ctx) {
    const result = [];
    let run = [];
    const flush = () => {
      const text = inline({ childNodes: run }, ctx).trim();
      if (text) result.push(escapeLineStarts(text));
      run = [];
    };
    for (const node of container.childNodes) {
      if (node.nodeType === 1 && BLOCK_TAGS.has(node.tagName)) {
        flush();
        result.push(...blockOf(node, ctx));
      } else {
        run.push(node);
      }
    }
    flush();
    return result;
  }

  /** Maps heading ids to GitHub-style anchors, so in-document links keep working. */
  function headingAnchors(content) {
    const anchors = new Map();
    const used = new Map();
    for (const heading of content.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
      const slug = heading.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
      const count = used.get(slug) ?? 0;
      used.set(slug, count + 1);
      if (heading.id) anchors.set(heading.id, count ? `${slug}-${count}` : slug);
    }
    return anchors;
  }

  /**
   * @param {Element} article The reader's article element.
   * @param {{title: string, url: string, date: string}} meta
   * @returns {string} GitHub-flavored Markdown.
   */
  function toMarkdown(article, meta) {
    const content = contentOf(article);
    const ctx = {
      anchors: headingAnchors(content),
      // The document title becomes the only level-1 heading; sections move down one level.
      headingOffset: content.querySelector(".doc-title") ? 1 : 0,
      lineBreak: "  \n",
    };
    const body = blocksOf(content, ctx).join("\n\n");
    const note = `*Exported from [${escapeText(meta.title)}](${meta.url}) on ${meta.date}.*`;
    return `${body}\n\n---\n\n${note}\n`;
  }

  // ---------------------------------------------------------------------------
  // Standalone HTML

  /** Follows the viewer's color scheme; without scripts the file stays light. */
  const THEME_SCRIPT = `
const root = document.querySelector(".root");
const dark = matchMedia("(prefers-color-scheme: dark)");
const apply = () => { root.dataset.theme = dark.matches ? "dark" : "light"; };
apply();
dark.addEventListener("change", apply);
addEventListener("beforeprint", () => { root.dataset.theme = "light"; });
addEventListener("afterprint", apply);
`;
  const EXPORT_CSS = `
body { margin: 0; }
.export-note { max-width: 46rem; margin: 3rem auto 0; color: var(--text-muted); font-size: 0.85em; }
`;

  /**
   * @param {Element} article The reader's article element.
   * @param {{title: string, siteTitle: string, url: string, date: string, css: string,
   *          images: Map<string, string>, doc: Document}} options `css` is the reader
   *   stylesheet; `images` maps image URLs to data URLs to embed; `doc` creates the nodes.
   * @returns {string} A complete HTML document with no external dependencies
   *   (images missing from `images` keep their remote URL).
   */
  function toHtml(article, options) {
    const page = options.doc.implementation.createHTMLDocument(`${options.title} - ${options.siteTitle}`);
    const element = (tag, attributes = {}, ...children) => {
      const node = page.createElement(tag);
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
      node.append(...children);
      return node;
    };

    const content = page.importNode(contentOf(article), true);
    for (const img of content.querySelectorAll("img")) {
      const embedded = options.images.get(img.getAttribute("src"));
      if (embedded) img.setAttribute("src", embedded);
    }

    page.documentElement.setAttribute("lang", "en");
    page.head.prepend(element("meta", { charset: "utf-8" }));
    page.head.append(
      element("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
      element("style", {}, options.css, EXPORT_CSS),
    );
    const source = element("a", { href: options.url }, options.title);
    page.body.append(
      // No top bar in the export, so headings need no offset when jumped to.
      element("div", { class: "root", "data-theme": "light", style: "--topbar-h: 0px" },
        element("div", { class: "app" },
          element("main", { class: "main" },
            content,
            element("p", { class: "export-note" }, "Exported from ", source, ` on ${options.date}.`),
          ),
        ),
      ),
      element("script", {}, THEME_SCRIPT),
    );
    return `<!DOCTYPE html>\n${page.documentElement.outerHTML}\n`;
  }

  return { toMarkdown, toHtml, fileName };
})();

if (typeof module !== "undefined") module.exports = Ics45cExporter;
