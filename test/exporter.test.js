// Unit tests for src/exporter.js against the reader's article markup.
const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const Exporter = require("../src/exporter.js");

const META = {
  title: "Homework 0",
  siteTitle: "45C Programming in C++",
  url: "https://sites.google.com/view/45c-programming-in-cpp/homework-0",
  date: "2026-10-07",
};

/** An <article> as the reader renders it, decorations included. */
function article(html) {
  const { document } = new JSDOM(`<!DOCTYPE html><body><article class="doc">${html}</article></body>`).window;
  return { document, element: document.querySelector("article") };
}

const markdown = (html) => Exporter.toMarkdown(article(html).element, META);
const body = (html) => markdown(html).split("\n\n---\n\n*Exported from")[0];

test("derives a file name from the page path", () => {
  assert.equal(Exporter.fileName("/view/45c-programming-in-cpp/course-info/assigned-reading", "md"), "ics45c-assigned-reading.md");
  assert.equal(Exporter.fileName("/", "html"), "ics45c-page.html");
});

test("exports headings, text formatting and the source note", () => {
  const out = markdown(
    `<p class="doc-title">45C Homework 0:</p>` +
      `<p class="doc-subtitle">Hello World</p>` +
      `<h1 id="h.a">Overview &amp; goals</h1>` +
      `<p>Use <strong>bold </strong>and <em>italic</em>, <code>cd ..</code>, <mark>marked</mark>, ` +
      `<span class="text-red">red</span> and a_b * c &lt;iostream&gt;.</p>` +
      `<h2 id="h.b">Details</h2><hr>` +
      `<p>1. not a list<br>- nor this</p>`,
  );
  assert.equal(
    out,
    [
      "# 45C Homework 0:",
      "*Hello World*",
      "## Overview & goals",
      "Use **bold** and *italic*, `cd ..`, <mark>marked</mark>, red and a\\_b \\* c \\<iostream\\>.",
      "### Details",
      "---",
      "1\\. not a list  \n\\- nor this",
      "---",
      "*Exported from [Homework 0](https://sites.google.com/view/45c-programming-in-cpp/homework-0) on 2026-10-07.*",
    ].join("\n\n") + "\n",
  );
});

test("exports code blocks with their language and without reader buttons", () => {
  const out = body(
    `<div class="code-block"><pre><code class="language-cpp"><span class="hljs-meta">#include</span> &lt;iostream&gt;\n` +
      `int x = 1; // \`tick\`</code></pre><button class="copy-btn" data-action="copy">copy</button></div>` +
      `<div class="code-block"><pre><code>Hello, World!</code></pre><button class="copy-btn">copy</button></div>` +
      `<p>Run <code>a\`b</code>.</p>`,
  );
  assert.equal(
    out,
    "```cpp\n#include <iostream>\nint x = 1; // `tick`\n```\n\n```\nHello, World!\n```\n\nRun ``a`b``.",
  );
});

test("exports nested and numbered lists", () => {
  const out = body(
    `<ol><li value="3">three<ul><li>dot<ul><li>deep</li></ul></li></ul></li><li value="4">four</li></ol>` +
      `<ul><li>plain <a href="https://example.com/a(b)">link</a></li></ul>`,
  );
  assert.equal(out, "3. three\n   - dot\n     - deep\n4. four\n\n- plain [link](https://example.com/a%28b%29)");
});

test("exports tables, with an empty header when the table has none", () => {
  const out = body(
    `<div class="table-wrap"><table><thead><tr><th>Command</th><th>What it does</th></tr></thead>` +
      `<tbody><tr><td><code>a | b</code></td><td><p>pipe</p><p>twice</p></td></tr></tbody></table></div>` +
      `<div class="table-wrap"><table><tbody><tr><td>1.4</td><td>Activities</td></tr></tbody></table></div>`,
  );
  assert.equal(
    out,
    "| Command | What it does |\n| --- | --- |\n| `a \\| b` | pipe<br>twice |\n\n" + "|  |  |\n| --- | --- |\n| 1.4 | Activities |",
  );
});

test("exports callouts as alerts and images without the OCR controls", () => {
  const out = body(
    `<aside class="callout callout-warning"><p><strong>Read carefully</strong></p><ul><li>one</li></ul></aside>` +
      `<aside class="callout"><p>Just a note.</p></aside>` +
      `<p class="media"><span class="image-wrap"><img src="https://docs.google.com/docs-images-rt/abc" alt="A [chart]">` +
      `<button class="ocr-btn" data-action="ocr">Copy text</button></span></p>` +
      `<div class="ocr-panel"><div class="ocr-text">recognized</div></div>`,
  );
  assert.equal(
    out,
    "> [!WARNING]\n> **Read carefully**\n>\n> - one\n\n> [!NOTE]\n> Just a note.\n\n" +
      "![A \\[chart\\]](https://docs.google.com/docs-images-rt/abc)",
  );
});

test("rewrites in-document links to heading anchors", () => {
  const out = body(
    `<nav class="doc-toc"><ul><li><a href="#h.one">1 Overview</a></li>` +
      `<li style="padding-left: 1em;"><a href="#h.two">Log in</a></li></ul></nav>` +
      `<h2 id="h.one">1 Overview</h2><h3 id="h.two">Log in</h3><h3 id="h.three">Log in</h3>` +
      `<p>See <a href="#h.three">again</a> or <a href="#ftnt1">[1]</a>.</p>`,
  );
  assert.equal(
    out,
    "- [1 Overview](#1-overview)\n  - [Log in](#log-in)\n\n## 1 Overview\n\n### Log in\n\n### Log in\n\n" +
      "See [again](#log-in-1) or \\[1\\].",
  );
});

test("builds a standalone HTML file with embedded images and no reader controls", () => {
  const { document, element } = article(
    `<h1 id="h.a">Title</h1>` +
      `<p class="media"><span class="image-wrap"><img src="https://docs.google.com/docs-images-rt/abc" alt="chart">` +
      `<button class="ocr-btn">Copy text</button></span></p>` +
      `<p><span class="image-wrap"><img src="https://docs.google.com/docs-images-rt/missing" alt=""></span></p>` +
      `<div class="code-block"><pre><code class="language-cpp"><span class="hljs-keyword">int</span> x;</code></pre>` +
      `<button class="copy-btn">copy</button></div>`,
  );
  const html = Exporter.toHtml(element, {
    ...META,
    css: ".doc { color: var(--text); }",
    images: new Map([["https://docs.google.com/docs-images-rt/abc", "data:image/png;base64,AAAA"]]),
    doc: document,
  });
  assert.match(html, /^<!DOCTYPE html>\n<html lang="en">/);
  const page = new JSDOM(html).window.document;
  assert.equal(page.title, "Homework 0 - 45C Programming in C++");
  assert.equal(page.querySelector("meta[charset]").getAttribute("charset"), "utf-8");
  assert.ok(page.querySelector("style").textContent.includes(".doc { color: var(--text); }"));
  assert.equal(page.querySelectorAll("button").length, 0);
  assert.equal(page.querySelector(".root > .app > .main > article.doc h1").id, "h.a");
  const sources = [...page.querySelectorAll("img")].map((img) => img.getAttribute("src"));
  assert.deepEqual(sources, ["data:image/png;base64,AAAA", "https://docs.google.com/docs-images-rt/missing"]);
  assert.equal(page.querySelector(".hljs-keyword").textContent, "int", "syntax highlighting is kept");
  assert.equal(page.querySelector(".export-note a").href, META.url);
  assert.equal(element.querySelectorAll("button").length, 2, "the reader's own article is not modified");
});
