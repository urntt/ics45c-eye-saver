// Unit tests for src/converter.js against synthetic "Publish to the web" markup.
const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const Converter = require("../src/converter.js");

// Mirrors the shape of the stylesheet Google Docs generates for published docs.
const DOC_CSS = `
@import url(https://themes.googleusercontent.com/fonts/css?kit=abc);
.lst-kix_num-0>li:before{content:"" counter(lst-ctn-kix_num-0,decimal) ". "}
.lst-kix_num-1>li:before{content:"" counter(lst-ctn-kix_num-1,lower-latin) ". "}
.lst-kix_dot-0>li:before{content:"\\0025cf   "}
.lst-kix_dot-1>li:before{content:"\\0025cb   "}
ol.lst-kix_num-0.start{counter-reset:lst-ctn-kix_num-0 0}
.mono{color:#188038;font-weight:400;font-family:"Roboto Mono"}
.bold{font-weight:700}
.italic{font-style:italic}
.hl{background-color:#ffe599}
.white{background-color:#ffffff}
.red{color:#ff0000}
.link{color:#1155cc;text-decoration:underline}
.plain{color:#000000;font-weight:400;font-family:"Arial"}
.indent{margin-left:36pt}
.center{text-align:center}
.head-cell{background-color:#4987ae}
.body-cell{background-color:#ffffff}
`;

const SITE = "https://sites.google.com/view/45c-programming-in-cpp";

function convert(body) {
  const source = new JSDOM(
    `<!DOCTYPE html><html><head><style type="text/css">${DOC_CSS}</style></head>` +
      `<body><div class="c0 doc-content">${body}</div></body></html>`,
  ).window.document;
  const target = new JSDOM("<!DOCTYPE html><body></body>").window.document;
  const container = target.createElement("div");
  container.append(Converter.convert(source, target, { siteOrigin: SITE }));
  return container;
}

const p = (html, cls = "") => `<p class="${cls}">${html}</p>`;
const span = (text, cls = "plain") => `<span class="${cls}">${text}</span>`;
const blank = (cls = "plain") => p(span("", cls));

test("merges consecutive monospace paragraphs into one code block", () => {
  const out = convert(
    p(span("Type this:")) +
      blank() +
      p(span("#include &lt;iostream&gt;", "mono")) +
      blank("mono") +
      p(span("int main() {", "mono")) +
      p(span("    return 0;", "mono")) +
      p(span("}", "mono")) +
      blank() +
      p(span("g++ main.cpp", "mono")),
  );
  const blocks = out.querySelectorAll("pre > code");
  assert.equal(blocks.length, 2, "a non-monospace blank line ends the block");
  assert.equal(blocks[0].textContent, "#include <iostream>\n\nint main() {\n    return 0;\n}");
  assert.equal(blocks[1].textContent, "g++ main.cpp");
});

test("detects the language of code blocks and leaves program output plain", () => {
  const cases = [
    ["#include <iostream>\n\nint main() {\n    return 0;\n}", "cpp"],
    ["TEST(SuiteName, TestName) {\n    EXPECT_EQ(2 + 2, 4);\n}", "cpp"],
    ["int count = 0;", "cpp"],
    ["CXXFLAGS = -std=c++20 -Wall\n\nmain: main.cpp\n        g++ $(CXXFLAGS) main.cpp -o main", "makefile"],
    ["git clone git@github.com:me/hw0.git\ncd hw0", "bash"],
    ["make          # build everything\nmake test", "bash"],
    ['git commit -a -m "Fixed: bug in reverse()"', "bash"],
    ["./build/hw", "bash"],
    ["$ ls -a", "bash"],
    ["Hello, World!", null],
    ["bash: ~klefstad/.bash_profile_fix: No such file or directory", null],
    ["[==========] Running 1 test from 1 test suite.\n[  PASSED  ] 1 test.", null],
    ["ics45c-hw0\n├── CMakeLists.txt\n└── src", null],
  ];
  for (const [code, expected] of cases) {
    assert.equal(Converter.detectCodeLanguage(code), expected, code);
  }
  const out = convert(p(span("g++ main.cpp", "mono")) + blank() + p(span("Hello, World!", "mono")));
  assert.deepEqual([...out.querySelectorAll("pre code")].map((code) => code.className), ["language-bash", ""]);
});

test("maps inline formatting to semantic tags and merges adjacent runs", () => {
  const out = convert(
    p(
      span("Run ") +
        span("cd ", "mono") +
        span("..", "mono bold") +
        span(" then ") +
        span("stop", "bold") +
        span(" now", "italic") +
        span(" please", "hl") +
        span(" or else", "red"),
    ),
  );
  const para = out.querySelector("p");
  assert.equal(para.querySelectorAll("code").length, 1, "adjacent code runs merge");
  assert.equal(para.querySelector("code").textContent, "cd ..");
  assert.equal(para.querySelector("strong").textContent, "stop");
  assert.equal(para.querySelector("em").textContent, " now");
  assert.equal(para.querySelector("mark").textContent, " please");
  assert.equal(para.querySelector(".text-red").textContent, " or else");
});

test("unwraps Google redirect links and filters unsafe targets", () => {
  const redirect = "https://www.google.com/url?q=https://git-scm.com/book&amp;sa=D&amp;usg=x";
  const out = convert(
    p(`<span class="link"><a href="${redirect}">book</a></span>`) +
      p(`<span class="link"><a href="${SITE}/syllabus">syllabus</a></span>`) +
      p(`<span class="link"><a href="javascript:alert(1)">bad</a></span>`) +
      p(`${span("See ")}<span class="link"><a href="#h.abc">below</a></span>`),
  );
  const links = [...out.querySelectorAll("a")];
  assert.deepEqual(
    links.map((a) => a.getAttribute("href")),
    ["https://git-scm.com/book", `${SITE}/syllabus`, "#h.abc"],
  );
  assert.equal(links[0].target, "_blank");
  assert.equal(links[0].rel, "noopener noreferrer");
  assert.equal(links[1].target, "", "course links stay in the same tab");
  assert.equal(out.querySelector("u"), null, "link underline is not re-applied as <u>");
});

test("rebuilds nested lists with numbering and marker styles", () => {
  const out = convert(
    `<ol class="c5 lst-kix_num-0 start" start="1">` +
      `<li class="c1">${span("one")}</li><li>${span("two")}</li></ol>` +
      `<ol class="c5 lst-kix_num-1 start" start="1"><li>${span("two-a")}</li></ol>` +
      blank() +
      `<ol class="c5 lst-kix_num-0" start="3"><li>${span("three")}</li></ol>` +
      `<ul class="c5 lst-kix_dot-0 start"><li>${span("dot")}</li></ul>` +
      `<ul class="c5 lst-kix_dot-1 start"><li>${span("sub-dot")}</li></ul>`,
  );
  const top = out.querySelector(":scope > ol");
  assert.equal(top.style.listStyleType, "decimal");
  assert.deepEqual([...top.children].map((li) => li.getAttribute("value")), ["1", "2", "3"]);
  const nested = top.children[1].querySelector("ol");
  assert.equal(nested.style.listStyleType, "lower-alpha");
  assert.equal(nested.textContent, "two-a");
  const bullets = out.querySelector(":scope > ul");
  assert.equal(bullets.style.listStyleType, "disc");
  assert.equal(bullets.querySelector("ul").style.listStyleType, "circle");
});

test("detects table header rows and keeps single commands inline", () => {
  const cell = (inner, cls = "body-cell") => `<td class="${cls}" colspan="1" rowspan="1">${inner}</td>`;
  const out = convert(
    `<table><tr>${cell(p(span("Command", "bold")))}${cell(p(span("What it does", "bold")))}</tr>` +
      `<tr>${cell(p(span("pwd", "mono bold")))}${cell(p(span("print working directory")))}</tr></table>` +
      `<table><tr>${cell(p(span("Week")), "head-cell")}${cell(p(span("Topic")), "head-cell")}</tr>` +
      `<tr>${cell(p(span("1")))}${cell(p(span("Intro")))}</tr></table>` +
      `<table><tr>${cell(p(span("1.4")))}${cell(p(span("Activities")))}</tr>` +
      `<tr>${cell(p(span("1.7")))}${cell(p(span("Glossary")))}</tr></table>` +
      `<table><tr>${cell(p(span("File", "bold")))}${cell(p(span("Contains", "bold")))}</tr>` +
      `<tr>${cell(p(span("src/a.hpp", "mono bold")))}${cell(p(span("main()", "mono bold")))}</tr></table>` +
      `<table><tr>${cell(p(span("ls", "mono bold")))}${cell(p(span("pwd", "mono bold")))}</tr>` +
      `<tr>${cell(p(span("cd", "mono bold")))}${cell(p(span("rm", "mono bold")))}</tr></table>`,
  );
  const tables = out.querySelectorAll(".table-wrap > table");
  assert.equal(tables.length, 5);
  assert.equal(tables[3].querySelector("thead th").textContent, "File", "a body of bold code does not hide the header");
  assert.equal(tables[4].querySelector("thead"), null, "a table of bold code alone has no header");
  assert.equal(tables[0].querySelector("thead th").textContent, "Command");
  assert.equal(tables[0].querySelector("tbody td code").textContent, "pwd");
  assert.equal(tables[0].querySelector("pre"), null);
  assert.equal(tables[1].querySelector("thead th").textContent, "Week", "tinted first row is a header");
  assert.equal(tables[2].querySelector("thead"), null, "plain first row stays in the body");
});

test("turns 1x1 tables into callouts or code blocks", () => {
  const box = (inner) => `<table><tr><td class="body-cell">${inner}</td></tr></table>`;
  const out = convert(
    box(p(span("⚠️ Passing Requirement", "bold")) + p(span("Read carefully."))) +
      box(p(span("Just a note."))) +
      box(p(span("ssh openlab", "mono")) + blank() + p(span("exit", "mono"))),
  );
  const callouts = out.querySelectorAll("aside.callout");
  assert.equal(callouts.length, 2);
  assert.ok(callouts[0].classList.contains("callout-warning"));
  assert.equal(callouts[1].className, "callout");
  assert.equal(out.querySelector("pre code").textContent, "ssh openlab\n\nexit");
});

test("keeps heading ids, drops empty headings, and marks title blocks", () => {
  const out = convert(
    p(span("45C Homework 0:"), "c1 title") +
      p(span("A subtitle"), "c1 subtitle") +
      `<h1 id="h.one">${span("Overview")}</h1>` +
      `<h2 id="h.empty">${span("")}</h2>` +
      p(span("Centered"), "center") +
      p(span("Indented"), "indent"),
  );
  assert.equal(out.querySelector(".doc-title").textContent, "45C Homework 0:");
  assert.equal(out.querySelector(".doc-subtitle").textContent, "A subtitle");
  assert.equal(out.querySelector("h1").id, "h.one");
  assert.equal(out.querySelector("h2"), null);
  assert.ok(out.querySelector("p.align-center"));
  assert.equal([...out.querySelectorAll("p")].at(-1).style.marginLeft, "2em");
});

test("groups the document's own internal-link contents into a nav", () => {
  const line = (href, text, cls = "") => p(`<span class="link"><a href="${href}">${text}</a></span>`, cls);
  const out = convert(line("#h.one", "1 Overview") + line("#h.two", "1.1 Details", "indent") + p(span("Body")));
  const toc = out.querySelector("nav.doc-toc");
  assert.ok(toc);
  assert.equal(toc.querySelectorAll("li").length, 2);
  assert.equal(toc.nextElementSibling.textContent, "Body");
});

test("never copies scripts, handlers or unsafe URLs into the output", () => {
  const out = convert(
    `<script>alert(1)</script>` +
      p(`<span class="plain" onclick="alert(1)" style="color:red">text</span>`) +
      p(`<span><img src="http://example.com/a.png" onerror="alert(1)"></span>`) +
      p(`<span><img src="https://docs.google.com/docs-images-rt/abc" alt="chart" style="width: 480.5px; height: 200px"></span>`) +
      `<hr style="page-break-before:always;display:none;">` +
      `<hr>`,
  );
  const html = out.innerHTML;
  assert.ok(!/script|onclick|onerror|alert|example\.com/.test(html), html);
  const images = out.querySelectorAll("img");
  assert.equal(images.length, 1, "only https images survive");
  assert.equal(images[0].getAttribute("loading"), "lazy");
  assert.match(images[0].getAttribute("style"), /aspect-ratio: 481 \/ 200/, "space is reserved before loading");
  assert.equal(out.querySelectorAll("hr").length, 1, "hidden page-break rules are skipped");
});

test("rejects pages that are not published Google Docs", () => {
  const source = new JSDOM("<!DOCTYPE html><body><p>hi</p></body>").window.document;
  assert.throws(() => Converter.convert(source, source), /doc-content/);
});
