/**
 * Converts a Google Docs "Publish to the web" page into clean, semantic DOM.
 *
 * Published Docs carry all formatting as generated class names
 * (`.c12{font-weight:700}`) plus a flat list model (`ul.lst-kix_<id>-<level>`).
 * The converter resolves those classes back into CSS declarations, keeps the
 * few properties that carry meaning (monospace, bold, highlight, list level,
 * ...) and emits plain tags that the reader stylesheet styles on its own.
 *
 * The output is built exclusively with `createElement`/`createTextNode`, so
 * no markup or attribute from the source document is copied verbatim; links
 * and images are filtered through URL allowlists.
 *
 * Loaded as a classic content script (shares the global scope with
 * content.js) and as a CommonJS module by the Node test suite.
 */
const Ics45cConverter = (() => {
  "use strict";

  const MONO_FONT = /mono|courier|consolas|inconsolata|menlo|monaco|source code|fira code|cousine|vt323|lekton/i;
  const LIST_CLASS = /\blst-kix_([\w]+)-(\d+)\b/;
  const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
  const COUNTER_STYLES = {
    "lower-latin": "lower-alpha",
    "upper-latin": "upper-alpha",
    decimal: "decimal",
    "lower-alpha": "lower-alpha",
    "upper-alpha": "upper-alpha",
    "lower-roman": "lower-roman",
    "upper-roman": "upper-roman",
    "decimal-leading-zero": "decimal-leading-zero",
  };
  const BULLET_STYLES = { "25cf": "disc", "25cb": "circle", "25a0": "square" };
  const CALLOUT_KINDS = [
    { kind: "warning", pattern: /^\s*(⚠|🚧)/u },
    { kind: "danger", pattern: /^\s*(❗|‼|🛑|⛔|❌)/u },
    { kind: "tip", pattern: /^\s*(💡|✅|✔)/u },
  ];
  const CPP_MARKERS = /^\s*#\s*include\b|\bstd::|\b(?:TEST|TEST_F)\s*\(|\b(?:EXPECT|ASSERT)_[A-Z_]+\s*\(|\bnullptr\b/m;
  const CPP_KEYWORDS = /\b(?:int|void|char|bool|double|float|auto|const|return|class|struct|namespace|template|using|public|private)\b/;
  const MAKE_TARGET = /^[\w.\/$()-]+(?:[ \t]+[\w.\/$()-]+)*[ \t]*:(?![:=])/m;
  const MAKE_VARIABLE = /^[A-Za-z_]\w*[ \t]*[:?+]?=|\$\(\w+\)/m;
  const SHELL_COMMANDS = new Set([
    "alias", "cat", "cd", "chmod", "clang", "clang++", "clear", "cmake", "cp", "ctest", "curl", "diff", "echo",
    "exit", "export", "find", "g++", "gcc", "gdb", "git", "grep", "head", "history", "less", "ln", "logout", "ls",
    "make", "man", "mkdir", "mv", "nano", "pwd", "python3", "rm", "rmdir", "scp", "source", "ssh", "ssh-add",
    "ssh-keygen", "tail", "tar", "touch", "tree", "unzip", "valgrind", "vi", "vim", "wget", "which",
  ]);
  /** One indent step in the reader, per 36pt (half an inch) of Docs indent. */
  const INDENT_EM_PER_PT = 2 / 36;

  // ---------------------------------------------------------------------------
  // Stylesheet resolution

  function parseDeclarations(text) {
    const declarations = new Map();
    for (const part of text.split(";")) {
      const colon = part.indexOf(":");
      if (colon < 0) continue;
      const property = part.slice(0, colon).trim().toLowerCase();
      const value = part.slice(colon + 1).trim();
      if (property) declarations.set(property, value);
    }
    return declarations;
  }

  /**
   * Reads the machine-generated Docs stylesheet.
   * @returns {{classes: Map<string, {order: number, declarations: Map<string, string>}>,
   *            listStyles: Map<string, string>}}
   */
  function parseDocStyles(cssText) {
    const classes = new Map();
    const listStyles = new Map();
    const css = cssText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import[^;]*;/g, "");
    const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
    let order = 0;
    for (const [, selectorText, body] of css.matchAll(rulePattern)) {
      for (const rawSelector of selectorText.split(",")) {
        const selector = rawSelector.replace(/\s+/g, "");
        const classMatch = /^\.([\w-]+)$/.exec(selector);
        if (classMatch) {
          const entry = classes.get(classMatch[1]) ?? { order: order++, declarations: new Map() };
          for (const [property, value] of parseDeclarations(body)) {
            entry.declarations.set(property, value);
          }
          classes.set(classMatch[1], entry);
          continue;
        }
        const markerMatch = /^\.lst-kix_([\w]+)-(\d+)>li:{1,2}before$/.exec(selector);
        if (markerMatch) {
          const style = listStyleFromMarker(parseDeclarations(body).get("content") ?? "");
          if (style) listStyles.set(`${markerMatch[1]}-${markerMatch[2]}`, style);
        }
      }
    }
    return { classes, listStyles };
  }

  function listStyleFromMarker(content) {
    const counter = /counter\(\s*[\w-]+\s*(?:,\s*([\w-]+)\s*)?\)/.exec(content);
    if (counter) return COUNTER_STYLES[counter[1] ?? "decimal"] ?? "decimal";
    const escape = /\\0*([0-9a-f]{4})/i.exec(content);
    return escape ? BULLET_STYLES[escape[1].toLowerCase()] ?? null : null;
  }

  function resolveStyle(element, ctx) {
    const entries = [];
    for (const className of element.classList) {
      const entry = ctx.styles.classes.get(className);
      if (entry) entries.push(entry);
    }
    entries.sort((a, b) => a.order - b.order);
    const style = new Map();
    for (const entry of entries) {
      for (const [property, value] of entry.declarations) style.set(property, value);
    }
    const inline = element.getAttribute("style");
    if (inline) {
      for (const [property, value] of parseDeclarations(inline)) style.set(property, value);
    }
    return style;
  }

  function parseColor(value) {
    if (!value) return null;
    const v = value.trim().toLowerCase();
    let match = /^#([0-9a-f]{6})$/.exec(v);
    if (match) {
      const n = parseInt(match[1], 16);
      return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    match = /^#([0-9a-f]{3})$/.exec(v);
    if (match) {
      const [r, g, b] = [...match[1]].map((c) => parseInt(c + c, 16));
      return { r, g, b, a: 1 };
    }
    match = /^rgba?\(([^)]+)\)$/.exec(v);
    if (match) {
      const [r, g, b, a = "1"] = match[1].split(",").map((s) => s.trim());
      return { r: Number(r), g: Number(g), b: Number(b), a: Number(a) };
    }
    return null;
  }

  /** A background that is visibly different from a white page. */
  function isTintedBackground(value) {
    const color = parseColor(value);
    return !!color && color.a > 0 && Math.min(color.r, color.g, color.b) < 245;
  }

  function isRedText(value) {
    const color = parseColor(value);
    return !!color && color.r >= 150 && color.g <= 100 && color.b <= 100;
  }

  function isMonoStyle(style) {
    return MONO_FONT.test(style.get("font-family") ?? "");
  }

  function isBoldStyle(style) {
    const weight = style.get("font-weight") ?? "";
    return weight === "bold" || Number(weight) >= 600;
  }

  function ptValue(value) {
    const match = /^(-?[\d.]+)pt$/.exec(value ?? "");
    return match ? Number(match[1]) : 0;
  }

  // ---------------------------------------------------------------------------
  // Text inspection helpers

  /** Text with <br> turned into newlines and non-breaking spaces normalized. */
  function plainText(node) {
    if (node.nodeType === 3) return node.data.replace(/ /g, " ");
    if (node.nodeType !== 1) return "";
    if (node.tagName === "BR") return "\n";
    let text = "";
    for (const child of node.childNodes) text += plainText(child);
    return text;
  }

  function isBlank(element) {
    return plainText(element).trim() === "" && !element.querySelector("img");
  }

  /** Spans that directly carry non-whitespace text. */
  function textSpans(element) {
    return [...element.querySelectorAll("span")].filter((span) =>
      [...span.childNodes].some((child) => child.nodeType === 3 && child.data.trim() !== ""),
    );
  }

  /**
   * Classifies a paragraph for code-block detection.
   * @returns {"code" | "code-blank" | "blank" | "text"}
   */
  function classifyParagraph(p, ctx) {
    if (p.querySelector("a[href], img")) return "text";
    const spans = [...p.querySelectorAll("span")];
    if (isBlank(p)) {
      const monoBlank = spans.length > 0 && spans.every((span) => isMonoStyle(resolveStyle(span, ctx)));
      return monoBlank ? "code-blank" : "blank";
    }
    const withText = textSpans(p);
    if (withText.length === 0) return "text";
    return withText.every((span) => isMonoStyle(resolveStyle(span, ctx))) ? "code" : "text";
  }

  function isBoldRow(row, ctx) {
    const spans = textSpans(row);
    return spans.length > 0 && spans.every((span) => isBoldStyle(resolveStyle(span, ctx)));
  }

  // ---------------------------------------------------------------------------
  // URLs

  /** Unwraps Google's link redirector and keeps only safe link targets. */
  function cleanHref(raw) {
    if (!raw) return null;
    if (raw.startsWith("#")) return raw;
    let url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.hostname === "www.google.com" && url.pathname === "/url" && url.searchParams.has("q")) {
      return cleanHref(url.searchParams.get("q"));
    }
    return LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
  }

  function cleanImageSrc(raw) {
    try {
      const url = new URL(raw);
      return url.protocol === "https:" ? url.href : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Inline content

  function inlineWrappers(style, { insideLink }) {
    const mono = isMonoStyle(style);
    const decoration = style.get("text-decoration") ?? "";
    const verticalAlign = style.get("vertical-align") ?? "";
    // Outermost first; code stays innermost so neighbouring code runs merge.
    const wrappers = [];
    if (isTintedBackground(style.get("background-color"))) wrappers.push({ tag: "mark" });
    if (!insideLink && isRedText(style.get("color"))) wrappers.push({ tag: "span", className: "text-red" });
    if (!mono && isBoldStyle(style)) wrappers.push({ tag: "strong" });
    if (!mono && style.get("font-style") === "italic") wrappers.push({ tag: "em" });
    if (!insideLink && decoration.includes("underline")) wrappers.push({ tag: "u" });
    if (decoration.includes("line-through")) wrappers.push({ tag: "s" });
    if (verticalAlign === "super") wrappers.push({ tag: "sup" });
    if (verticalAlign === "sub") wrappers.push({ tag: "sub" });
    if (mono) wrappers.push({ tag: "code" });
    return wrappers;
  }

  function convertImage(img, ctx) {
    const src = cleanImageSrc(img.getAttribute("src"));
    if (!src) return null;
    const out = ctx.doc.createElement("img");
    out.src = src;
    out.alt = img.getAttribute("alt") ?? "";
    out.setAttribute("loading", "lazy");
    const title = img.getAttribute("title");
    if (title) out.title = title;
    const width = parseFloat(resolveStyle(img, ctx).get("width") ?? "");
    if (width > 0) out.style.width = `min(100%, ${Math.round(width)}px)`;
    return out;
  }

  function appendInline(source, dest, ctx, { insideLink = false } = {}) {
    for (const node of source.childNodes) {
      if (node.nodeType === 3) {
        dest.append(ctx.doc.createTextNode(node.data));
        continue;
      }
      if (node.nodeType !== 1) continue;
      switch (node.tagName) {
        case "SPAN": {
          const hasLink = insideLink || !!node.querySelector("a[href]");
          let target = dest;
          for (const wrapper of inlineWrappers(resolveStyle(node, ctx), { insideLink: hasLink })) {
            const element = ctx.doc.createElement(wrapper.tag);
            if (wrapper.className) element.className = wrapper.className;
            target.append(element);
            target = element;
          }
          appendInline(node, target, ctx, { insideLink });
          break;
        }
        case "A": {
          const href = cleanHref(node.getAttribute("href"));
          const link = ctx.doc.createElement(href ? "a" : "span");
          if (href) {
            link.href = href;
            if (!href.startsWith("#") && !href.startsWith(ctx.siteOrigin)) {
              link.target = "_blank";
              link.rel = "noopener noreferrer";
            }
          }
          if (node.id) link.id = node.id;
          appendInline(node, link, ctx, { insideLink: true });
          dest.append(link);
          break;
        }
        case "IMG": {
          const image = convertImage(node, ctx);
          if (image) dest.append(image);
          break;
        }
        case "BR":
          dest.append(ctx.doc.createElement("br"));
          break;
        case "SUP":
        case "SUB": {
          const element = ctx.doc.createElement(node.tagName.toLowerCase());
          appendInline(node, element, ctx, { insideLink });
          dest.append(element);
          break;
        }
        default:
          appendInline(node, dest, ctx, { insideLink });
      }
    }
  }

  function sameShape(a, b) {
    if (a.tagName !== b.tagName || a.id || b.id) return false;
    if (a.attributes.length !== b.attributes.length) return false;
    for (const { name, value } of a.attributes) {
      if (b.getAttribute(name) !== value) return false;
    }
    return a.tagName !== "IMG" && a.tagName !== "BR";
  }

  /** Merges adjacent inline elements with identical tag and attributes. */
  function mergeAdjacent(element) {
    let child = element.firstChild;
    while (child) {
      const next = child.nextSibling;
      if (next && child.nodeType === 1 && next.nodeType === 1 && sameShape(child, next)) {
        child.append(...next.childNodes);
        next.remove();
        continue;
      }
      if (child.nodeType === 1) mergeAdjacent(child);
      child = next;
    }
    element.normalize();
  }

  function convertInlineInto(source, dest, ctx) {
    appendInline(source, dest, ctx);
    mergeAdjacent(dest);
    return dest;
  }

  // ---------------------------------------------------------------------------
  // Blocks

  function applyParagraphLayout(source, out, ctx) {
    const style = resolveStyle(source, ctx);
    const indent = ptValue(style.get("margin-left"));
    if (indent > 0) out.style.marginLeft = `${+(indent * INDENT_EM_PER_PT).toFixed(2)}em`;
    const align = style.get("text-align");
    if (align === "center" || align === "right") out.classList.add(`align-${align}`);
  }

  function isInternalLinkLine(p) {
    const links = p.querySelectorAll("a[href]");
    return (
      links.length === 1 &&
      links[0].getAttribute("href").startsWith("#") &&
      plainText(links[0]).trim() === plainText(p).trim()
    );
  }

  /**
   * Accumulates consecutive Docs list elements and rebuilds real nesting.
   * Docs emits one flat <ul>/<ol> per run and encodes depth in the class
   * name; numbering is carried by the `start` attribute of each <ol>.
   */
  class ListBuilder {
    constructor(ctx, out) {
      this.ctx = ctx;
      this.out = out;
      this.stack = [];
    }

    add(listElement) {
      const [, listId = "", levelText = "0"] = LIST_CLASS.exec(listElement.className) ?? [];
      const level = Number(levelText);
      const ordered = listElement.tagName === "OL";
      let number = Number(listElement.getAttribute("start") ?? "1") || 1;
      for (const item of listElement.children) {
        if (item.tagName !== "LI") continue;
        const list = this.listFor(level, ordered, listId);
        const li = this.ctx.doc.createElement("li");
        if (ordered) li.setAttribute("value", String(number++));
        convertInlineInto(item, li, this.ctx);
        list.element.append(li);
        list.lastItem = li;
      }
    }

    listFor(level, ordered, listId) {
      const tag = ordered ? "ol" : "ul";
      while (this.stack.length && this.top.level > level) this.stack.pop();
      if (this.stack.length && this.top.level === level && (this.top.tag !== tag || this.top.listId !== listId)) {
        this.stack.pop();
      }
      if (this.stack.length && this.top.level === level) return this.top;
      const element = this.ctx.doc.createElement(tag);
      const style = this.ctx.styles.listStyles.get(`${listId}-${level}`);
      if (style) element.style.listStyleType = style;
      (this.top?.lastItem ?? this.out).append(element);
      const entry = { level, tag, listId, element, lastItem: null };
      this.stack.push(entry);
      return entry;
    }

    get top() {
      return this.stack[this.stack.length - 1];
    }

    close() {
      this.stack = [];
    }
  }

  /**
   * Guesses the language of a code block, which Docs does not record.
   * Returns one of the grammars bundled in vendor/highlight.js, or null for
   * program output and anything unrecognized (left unhighlighted).
   */
  function detectCodeLanguage(text) {
    const lines = text.split("\n").filter((line) => line.trim());
    if (lines.length === 0) return null;
    if (CPP_MARKERS.test(text) || (CPP_KEYWORDS.test(text) && /[;{]\s*$|^\s*}/m.test(text))) return "cpp";
    if (MAKE_TARGET.test(text) && (MAKE_VARIABLE.test(text) || /^\s+\S/m.test(text))) return "makefile";
    const isCommand = (line) => {
      const word = line.trim().replace(/^\$\s+/, "").split(/\s+/)[0];
      return SHELL_COMMANDS.has(word) || word.startsWith("./");
    };
    return lines.every(isCommand) ? "bash" : null;
  }

  function createCodeBlock(lines, ctx) {
    const pre = ctx.doc.createElement("pre");
    const code = ctx.doc.createElement("code");
    code.textContent = lines.join("\n");
    const language = detectCodeLanguage(code.textContent);
    if (language) code.className = `language-${language}`;
    pre.append(code);
    return pre;
  }

  function convertTable(table, ctx) {
    const rows = [...table.querySelectorAll("tr")].filter((row) => row.closest("table") === table);
    const cellsOf = (row) => [...row.children].filter((cell) => cell.tagName === "TD" || cell.tagName === "TH");
    if (rows.length === 1 && cellsOf(rows[0]).length === 1) {
      return convertSingleCellTable(cellsOf(rows[0])[0], ctx);
    }

    const out = ctx.doc.createElement("table");
    const headerRow = rows.length > 1 && isHeaderRow(rows[0], rows[1], cellsOf, ctx);
    let body = null;
    rows.forEach((row, index) => {
      const isHeader = headerRow && index === 0;
      const section = isHeader ? ctx.doc.createElement("thead") : (body ??= ctx.doc.createElement("tbody"));
      const tr = ctx.doc.createElement("tr");
      for (const cell of cellsOf(row)) {
        const td = ctx.doc.createElement(isHeader ? "th" : "td");
        for (const attribute of ["colspan", "rowspan"]) {
          const span = Number(cell.getAttribute(attribute));
          if (span > 1) td.setAttribute(attribute, String(span));
        }
        convertBlocks(cell.childNodes, td, { ...ctx, inTableCell: true });
        unwrapSoleParagraph(td);
        tr.append(td);
      }
      section.append(tr);
      if (!section.parentNode) out.append(section);
    });

    const wrap = ctx.doc.createElement("div");
    wrap.className = "table-wrap";
    wrap.append(out);
    return wrap;
  }

  function isHeaderRow(first, second, cellsOf, ctx) {
    if (isBoldRow(first, ctx) && !isBoldRow(second, ctx)) return true;
    const background = (row) => cellsOf(row).map((cell) => resolveStyle(cell, ctx).get("background-color") ?? "");
    const firstBackgrounds = background(first);
    return (
      firstBackgrounds.every(isTintedBackground) &&
      firstBackgrounds[0] !== background(second)[0]
    );
  }

  /** Docs users box code or notes in 1x1 tables; turn those into blocks. */
  function convertSingleCellTable(cell, ctx) {
    const paragraphs = [...cell.children].filter((child) => child.tagName === "P");
    const kinds = paragraphs.map((p) => classifyParagraph(p, ctx));
    const onlyParagraphs = paragraphs.length === cell.children.length;
    if (onlyParagraphs && kinds.includes("code") && kinds.every((kind) => kind !== "text")) {
      const lines = paragraphs.map((p, i) => (kinds[i] === "code" ? plainText(p).replace(/\s+$/, "") : ""));
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      while (lines.length && lines[0] === "") lines.shift();
      return createCodeBlock(lines, ctx);
    }

    const aside = ctx.doc.createElement("aside");
    aside.className = "callout";
    const text = plainText(cell);
    const kind = CALLOUT_KINDS.find(({ pattern }) => pattern.test(text))?.kind;
    if (kind) aside.classList.add(`callout-${kind}`);
    convertBlocks(cell.childNodes, aside, ctx);
    return aside;
  }

  function unwrapSoleParagraph(container) {
    if (container.childNodes.length === 1 && container.firstChild.tagName === "P") {
      const p = container.firstChild;
      container.append(...p.childNodes);
      p.remove();
    }
  }

  function headingFrom(source, ctx) {
    if (isBlank(source)) return null;
    const heading = convertInlineInto(source, ctx.doc.createElement(source.tagName.toLowerCase()), ctx);
    if (source.id) heading.id = source.id;
    return heading;
  }

  function paragraphFrom(source, ctx) {
    const classList = source.classList;
    const p = ctx.doc.createElement("p");
    if (classList.contains("title")) p.className = "doc-title";
    else if (classList.contains("subtitle")) p.className = "doc-subtitle";
    else applyParagraphLayout(source, p, ctx);
    convertInlineInto(source, p, ctx);
    if (p.childNodes.length === 1 && p.firstChild.tagName === "IMG") p.classList.add("media");
    return p;
  }

  /**
   * Converts a sequence of Docs block nodes, appending the result to `out`.
   * Runs of code paragraphs, list elements and internal-link lines (the
   * document's own table of contents) are grouped while walking.
   */
  function convertBlocks(nodes, out, ctx) {
    const lists = new ListBuilder(ctx, out);
    let code = null; // { lines: string[], sources: Element[], pendingBlanks: number }
    let toc = null; // <ul> collecting internal-link lines

    const flushCode = () => {
      // A lone monospace line in a table cell is a term (`pwd`), not a listing.
      if (code && ctx.inTableCell && code.lines.length === 1) out.append(paragraphFrom(code.sources[0], ctx));
      else if (code) out.append(createCodeBlock(code.lines, ctx));
      code = null;
    };
    const flushToc = () => {
      toc = null;
    };
    const flushAll = () => {
      flushCode();
      flushToc();
      lists.close();
    };

    for (const node of nodes) {
      if (node.nodeType !== 1) continue;
      const tag = node.tagName;

      if (tag === "P") {
        const kind = classifyParagraph(node, ctx);
        if (kind === "code") {
          flushToc();
          lists.close();
          const line = plainText(node).replace(/\s+$/, "");
          if (code) code.lines.push(...Array(code.pendingBlanks).fill(""), line);
          else code = { lines: [line], sources: [] };
          code.sources.push(node);
          code.pendingBlanks = 0;
          continue;
        }
        if (kind === "code-blank" && code) {
          code.pendingBlanks++;
          continue;
        }
        if (kind === "blank" || kind === "code-blank") {
          flushCode();
          continue;
        }
        if (isInternalLinkLine(node)) {
          flushCode();
          lists.close();
          if (!toc) {
            const nav = ctx.doc.createElement("nav");
            nav.className = "doc-toc";
            toc = ctx.doc.createElement("ul");
            nav.append(toc);
            out.append(nav);
          }
          const li = convertInlineInto(node, ctx.doc.createElement("li"), ctx);
          const indent = ptValue(resolveStyle(node, ctx).get("margin-left"));
          if (indent > 0) li.style.paddingLeft = `${+(indent * INDENT_EM_PER_PT).toFixed(2)}em`;
          toc.append(li);
          continue;
        }
        flushAll();
        out.append(paragraphFrom(node, ctx));
        continue;
      }

      if (tag === "UL" || tag === "OL") {
        flushCode();
        flushToc();
        lists.add(node);
        continue;
      }

      flushAll();
      if (/^H[1-6]$/.test(tag)) {
        const heading = headingFrom(node, ctx);
        if (heading) out.append(heading);
      } else if (tag === "TABLE") {
        out.append(convertTable(node, ctx));
      } else if (tag === "HR") {
        if (!/display:\s*none/.test(node.getAttribute("style") ?? "")) out.append(ctx.doc.createElement("hr"));
      } else if (tag === "DIV") {
        convertBlocks(node.childNodes, out, ctx);
      }
    }
    flushAll();
  }

  // ---------------------------------------------------------------------------
  // Public API

  /**
   * @param {Document} source Parsed published-doc page.
   * @param {Document} target Document used to create the output nodes.
   * @param {{siteOrigin?: string}} [options] Links under `siteOrigin` open in
   *   the same tab; everything else opens in a new one.
   * @returns {DocumentFragment}
   */
  function convert(source, target, options = {}) {
    const content = source.querySelector(".doc-content");
    if (!content) throw new Error("Not a published Google Docs page (no .doc-content)");
    const cssText = [...source.querySelectorAll("style")].map((style) => style.textContent).join("\n");
    const ctx = {
      doc: target,
      styles: parseDocStyles(cssText),
      siteOrigin: options.siteOrigin ?? "https://sites.google.com/",
    };
    const fragment = target.createDocumentFragment();
    convertBlocks(content.childNodes, fragment, ctx);
    return fragment;
  }

  return { convert, cleanHref, parseDocStyles, detectCodeLanguage };
})();

if (typeof module !== "undefined") module.exports = Ics45cConverter;
