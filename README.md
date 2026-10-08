# ICS 45C Eye Saver

A Chromium browser extension (Chrome, Edge, Brave, …) for the
[ICS 45C course site](https://sites.google.com/view/45c-programming-in-cpp).

Most course pages are a Google Sites page whose only content is a published
Google Doc, embedded through three nested iframes in a fixed-height tile. The
result is a small box with its own scrollbar inside the page, Google Docs'
print-oriented typography, and no dark mode.

On those pages the extension fetches the published document and renders it
natively into the page as a reader view:

- The document scrolls with the page itself: no inner scroll box.
- Clean typography with a readable line length, in light, dark, or
  follow-the-system theme (the choice is remembered).
- Course navigation on the left, an "On this page" outline with scroll
  tracking on the right, and a slide-out drawer on narrow screens. Either side
  panel can be collapsed from the top bar for a wider reading area (also
  remembered).
- Monospace paragraphs become real code blocks with a copy button and syntax
  highlighting for C++, shell commands and Makefiles (program output stays
  plain). Code is shown without font ligatures, so `<<` looks exactly like
  what you type.
- Images get a "Copy text" button: the text in the image is recognized on
  your machine (OCR), shown under the image and copied to the clipboard.
  Screenshots of code come out as code: the editor's line numbers are
  removed and indentation is kept.
- Tables get header rows, one-cell tables become callout boxes (warning,
  tip, …), links to sections jump in place, and the Back button returns to
  where you were.
- **Export** saves the page as a Markdown file (or copies the Markdown), as a
  single HTML file that works offline with its images included, or as a PDF
  through the print dialog.
- "Original" switches back to the untouched Google Sites page at any time;
  "Source" opens the published document in a new tab.

Pages that contain anything besides such embeds (for example the home page)
are left alone. Animations follow the system's reduced-motion setting (on
Windows: Settings → Accessibility → Visual effects → Animation effects).

## Install

1. Download the latest release or clone this repository.
2. If you got a zip file, unzip it to get the repository folder.
3. Open `chrome://extensions` (or `edge://extensions`) and turn on
   **Developer mode**.
4. Click **Load unpacked** and select the repository folder.
5. Open any course page, such as
   [Syllabus](https://sites.google.com/view/45c-programming-in-cpp/syllabus).

After pulling updates, click the reload icon on the extension's card and
refresh the course tab.

## How it works

```text
sites.google.com/view/45c-programming-in-cpp/*          docs.google.com
┌──────────────────────────────────────────────┐        ┌───────────────────────┐
│ content.js                                   │  msg   │ background.js         │
│  1. read embed code from [data-code] tiles   ├───────►│  fetch .../pub?       │
│  2. build shadow-DOM reader, hide Sites UI   │◄───────┤  embedded=true        │
│  3. converter.js: Docs HTML -> clean DOM     │  HTML  └──────────┬────────────┘
│  4. "Copy text" on an image                  │  text             │ OCR request
└──────────────────────────────────────────────┘        ┌──────────▼────────────┐
                                                        │ offscreen.html        │
                                                        │  Tesseract.js worker  │
                                                        └───────────────────────┘
```

- **`src/content.js`** runs on course pages at `document_start` and hides the
  page until it has decided whether to take over (at most a few seconds). It
  activates only when every embed on the page is a published Google Doc
  (rendered natively) or another Google Docs/Drive embed (shown as a single
  full-height frame), and nothing else is on the page. The reader lives in a
  shadow root, so its styles and Google Sites' styles do not affect each other.
  The course navigation is read from the Sites header.
- **`src/background.js`** fetches the published document. Content scripts are
  bound by the page's CORS rules, so this has to happen in the service worker.
  It only accepts a published-document id and builds the URL itself. It also
  forwards OCR requests (only for images on Google Docs' image host) to the
  offscreen document, which it opens on first use.
- **`src/offscreen.js`** runs [Tesseract.js](https://github.com/naptha/tesseract.js)
  in a hidden extension page: Tesseract needs a Web Worker and WebAssembly,
  which neither the course page nor the service worker can host. The engine
  is released after a few idle minutes to free memory.
- **`src/ocr-layout.js`** post-processes the OCR result. Tesseract's text
  drops leading whitespace and keeps line-number gutters, so when the words
  sit on a monospace grid (code, terminal output) the text is rebuilt from the
  word positions: the gutter and misread indent guides are removed and
  indentation is restored. Charts and prose keep Tesseract's text.
- **`src/converter.js`** turns the published HTML into semantic markup. Google
  Docs expresses all formatting through generated classes (`.c12{…}`), so the
  converter resolves those classes against the document's stylesheet and maps
  the properties that carry meaning: monospace → code, bold/italic,
  highlight → `<mark>`, red text, list depth and numbering, table headers,
  indentation. Output is built with `createElement` only; scripts, event
  handlers and non-HTTP(S) URLs never make it through, and Google's
  `google.com/url?q=` link redirects are unwrapped.
  Docs does not record a code block's language, so the converter infers it
  from the content (`detectCodeLanguage`) and marks the block `language-*`.
- **`src/exporter.js`** generates the exports from the reader's own DOM, so a
  file contains what the reader shows, minus its buttons. Markdown is
  GitHub-flavored (fenced code with languages, tables, alerts for callouts,
  in-document links rewritten to heading anchors). The HTML file inlines the
  reader stylesheet and embeds images as data URLs, which the service worker
  fetches. PDF is the browser's print dialog with a print stylesheet: light
  theme, no reader chrome, wrapped code lines.
- **`vendor/`** holds third-party code, generated by `npm run vendor` and
  committed because Manifest V3 does not allow loading remote code:
  `highlight.js` is a [highlight.js](https://highlightjs.org/) bundle with only
  the C++, Bash and Makefile grammars (~32 KB), and `tesseract/` is
  Tesseract.js with its WebAssembly core and English model (~6 MB). Nothing is
  downloaded at runtime, so OCR also works offline and images never leave your
  machine.
- **`src/reader.css`** is the reader's stylesheet. Colors, including syntax
  colors, are tokens per theme.

Permissions: `storage` (theme and panel preferences), `offscreen` (the OCR
page), and host access to `docs.google.com` (fetching published documents and
their images). Extension pages are allowed `'wasm-unsafe-eval'` so the OCR
engine's WebAssembly can compile. The content script only matches
`https://sites.google.com/view/45c-programming-in-cpp/*`.

## Development

```bash
npm install
```

```bash
npm test
```

Runs the converter unit tests (Node's test runner with jsdom) against
synthetic Docs markup.

```bash
npm run vendor
```

Regenerates `vendor/` from the `highlight.js`, `tesseract.js` and
`@tesseract.js-data/eng` dev dependencies. Run it after upgrading them or
changing the bundled highlight.js languages (keep those in sync with
`detectCodeLanguage` in `src/converter.js`), and commit the result.

```bash
npm run smoke
```

Launches a local Chrome headlessly with the extension installed, opens live
course pages in desktop and mobile sizes and both color schemes, and checks
activation plus the main controls (contents links and Back, Original/Reader
toggle, syntax highlighting, copy button, theme persistence, sidebar group
animation, collapsing side panels, mobile drawer, OCR on an image, and the
Markdown, HTML and print exports).
Screenshots are written to `smoke-output/`. Set
`CHROME_PATH` if Chrome is not in its default location.
Because it depends on the live site, run it after changes to
`content.js`, and whenever the course site looks different.

## Limitations

- The extension depends on how Google Sites marks up embeds (`data-code`) and
  how Google Docs publishes documents (`.doc-content`, generated classes). If
  Google changes either, the page falls back to the original Sites view or the
  reader shows an error with a button to return to the original page.
- Google Drive files other than published Docs (PDFs, Slides, …) are shown in a
  full-height frame rather than converted.
- OCR recognizes English only and works on images embedded in the published
  Docs. Recognition is not perfect, especially for small text in charts, and
  Tesseract tends to miss a character that stands alone on a line (such as a
  closing `}`), so double-check what it copies.
- Exported Markdown links to images on Google's servers rather than embedding
  them, so they need a connection and follow later changes to the document;
  use the HTML or PDF export for a self-contained copy. Markdown has no text
  color, so red text is exported as plain text.
- Firefox is not supported yet.

## License

MIT License
