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
  tracking on the right, and a slide-out drawer on narrow screens.
- Monospace paragraphs become real code blocks with a copy button and syntax
  highlighting for C++, shell commands and Makefiles (program output stays
  plain). Code is shown without font ligatures, so `<<` looks exactly like
  what you type.
- Tables get header rows, one-cell tables become callout boxes (warning,
  tip, …), links to sections jump in place, and the Back button returns to
  where you were.
- "Original" switches back to the untouched Google Sites page at any time;
  "Source" opens the published document in a new tab.

Pages that contain anything besides such embeds (for example the home page)
are left alone.

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
│  3. converter.js: Docs HTML -> clean DOM     │  HTML  └───────────────────────┘
└──────────────────────────────────────────────┘
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
  It only accepts a published-document id and builds the URL itself.
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
- **`vendor/highlight.js`** is a generated [highlight.js](https://highlightjs.org/)
  bundle with only the C++, Bash and Makefile grammars (~32 KB). Manifest V3
  does not allow loading remote code, so it is built locally and committed;
  the content script highlights the marked blocks with it.
- **`src/reader.css`** is the reader's stylesheet. Colors, including syntax
  colors, are tokens per theme.

Permissions: `storage` (theme preference) and host access to
`docs.google.com` (fetching published documents). The content script only
matches `https://sites.google.com/view/45c-programming-in-cpp/*`.

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
npm run build:highlight
```

Regenerates `vendor/highlight.js` from the `highlight.js` dev dependency.
Run it after upgrading highlight.js or changing the bundled languages (keep
them in sync with `detectCodeLanguage` in `src/converter.js`), and commit the
result.

```bash
npm run smoke
```

Launches a local Chrome headlessly with the extension installed, opens live
course pages in desktop and mobile sizes and both color schemes, and checks
activation plus the main controls (contents links and Back, Original/Reader
toggle, syntax highlighting, copy button, theme persistence, sidebar group
animation, mobile drawer). Screenshots are written to `smoke-output/`. Set
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
- Firefox is not supported yet.

## License

MIT License
