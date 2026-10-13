/**
 * Rebuilds the text layout of a Tesseract OCR result.
 *
 * Tesseract's plain text is prose-oriented: it drops leading whitespace,
 * keeps an editor's line-number gutter as part of each line, and separates
 * most lines with an empty one. Course images are mostly screenshots of code
 * or terminal output, so when the words sit on a monospace grid the text is
 * rebuilt from the word boxes instead: a numbered gutter is removed, and
 * indentation and alignment spaces are restored from the x positions.
 * Anything else (charts, prose) keeps Tesseract's own text.
 *
 * Tesseract also tends to attach a glyph that stands alone on a short line (a
 * closing brace) to the line above and to misread it there (")" for "}"). Such
 * words are put back on the line they sit on and re-read on their own.
 *
 * Loaded as a classic script by src/offscreen.html and as a CommonJS module
 * by the Node tests.
 */
const Ics45cOcrLayout = (() => {
  "use strict";

  /**
   * On a monospace grid, the distance between the starts of adjacent words
   * divided by (characters + 1 space) is the same everywhere. Above this
   * relative spread the font is treated as proportional (code screenshots
   * measure under 0.03, a chart in Arial about 0.09).
   */
  const MONOSPACE_MAX_SPREAD = 0.05;
  const MONOSPACE_MIN_PAIRS = 4;
  /** Share of lines that must carry the expected line number to count as a gutter. */
  const GUTTER_MIN_SHARE = 0.6;

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  const middleOf = (word) => (word.y0 + word.y1) / 2;

  /** Flattens Tesseract's blocks into lines of words, top to bottom. */
  function linesOf(blocks) {
    const lines = [];
    for (const block of blocks ?? []) {
      for (const paragraph of block.paragraphs ?? []) {
        for (const line of paragraph.lines ?? []) {
          const words = (line.words ?? [])
            .filter((word) => word.text.trim())
            .map((word) => ({ text: word.text.trim(), ...word.bbox }));
          if (words.length) lines.push({ y0: line.bbox.y0, words });
        }
      }
    }
    return lines.sort((a, b) => a.y0 - b.y0);
  }

  /**
   * Puts each word on the line it actually sits on: a word whose vertical
   * middle is nearer to a neighbouring line than to its own is moved there
   * and marked `moved`.
   */
  function rehomeWords(lines) {
    const middles = lines.map((line) => median(line.words.map(middleOf)));
    const result = lines.map((line) => ({ ...line, words: [] }));
    lines.forEach((line, index) => {
      for (const word of line.words) {
        let home = index;
        for (const neighbour of [index - 1, index + 1]) {
          if (neighbour < 0 || neighbour >= lines.length) continue;
          if (Math.abs(middleOf(word) - middles[neighbour]) < Math.abs(middleOf(word) - middles[home])) home = neighbour;
        }
        result[home].words.push(home === index ? word : { ...word, moved: true });
      }
    });
    for (const line of result) line.words.sort((a, b) => a.x0 - b.x0);
    return result.filter((line) => line.words.length);
  }

  /**
   * Removes a gutter of increasing line numbers (1, 2, 3, ...). A number that
   * OCR glued to the code ("31};") is split off; such a line loses its x
   * position and is placed at column 0. Anything else that ends left of the
   * code column (a misread number) is gutter too. Returns null when there is
   * no gutter.
   */
  function stripLineNumbers(lines) {
    let previous = null;
    let matched = 0;
    const numbered = lines.map((line) => {
      const [head, ...rest] = line.words;
      const digits = /^\d{1,4}/.exec(head.text)?.[0];
      const value = Number(digits);
      const fits = digits !== undefined && (previous === null ? value <= 2 : value > previous && value <= previous + 3);
      if (!fits) return line;
      previous = value;
      matched++;
      const remainder = head.text.slice(digits.length);
      const words = remainder ? [{ text: remainder, x0: null, x1: null }, ...rest] : rest;
      return { ...line, words, numbered: true };
    });
    if (matched < 2 || matched < lines.length * GUTTER_MIN_SHARE) return null;
    const codeLeft = Math.min(
      ...numbered.filter((line) => line.numbered && line.words[0]?.x0 != null).map((line) => line.words[0].x0),
    );
    return numbered.map((line) => {
      let words = line.words;
      while (words.length && words[0].x1 !== null && words[0].x1 < codeLeft) words = words.slice(1);
      return { ...line, words };
    });
  }

  /** The character pitch of a monospace grid, or null when the font is proportional. */
  function monospacePitch(lines) {
    const pitches = [];
    for (const { words } of lines) {
      for (let i = 0; i + 1 < words.length; i++) {
        if (words[i].x0 === null || words[i + 1].x0 === null) continue;
        pitches.push((words[i + 1].x0 - words[i].x0) / (words[i].text.length + 1));
      }
    }
    if (pitches.length < MONOSPACE_MIN_PAIRS) return null;
    const pitch = median(pitches);
    const spread = median(pitches.map((value) => Math.abs(value - pitch))) / pitch;
    return spread <= MONOSPACE_MAX_SPREAD ? pitch : null;
  }

  /**
   * Re-reads single glyphs that were moved to another line: recognized as part
   * of the wrong line they are often misread, on their own they are not.
   */
  async function rereadMovedGlyphs(lines, rereadGlyph) {
    for (const { words } of lines) {
      for (const word of words) {
        if (!word.moved || word.text.length !== 1) continue;
        const text = (await rereadGlyph({ x0: word.x0, y0: word.y0, x1: word.x1, y1: word.y1 })).trim();
        if (text.length === 1) word.text = text;
      }
    }
  }

  /** Places each line's words on the character grid, starting at the leftmost word. */
  function layOut(lines, pitch) {
    const left = Math.min(...lines.flatMap((line) => line.words).filter((word) => word.x0 !== null).map((word) => word.x0));
    return lines.map((line) => {
      let text = "";
      for (const word of line.words) {
        const column = word.x0 === null ? text.length : Math.round((word.x0 - left) / pitch);
        text += " ".repeat(text ? Math.max(1, column - text.length) : Math.max(0, column)) + word.text;
      }
      return text;
    });
  }

  /**
   * @param {{text: string, blocks?: object[]}} data Tesseract's result with blocks.
   * @param {(box: {x0: number, y0: number, x1: number, y1: number}) => Promise<string>} [rereadGlyph]
   *   Recognizes the single character inside a box of the same image.
   * @returns {Promise<{text: string, code: boolean}>} `code` is true when the
   *   layout was rebuilt on a monospace grid (show it in a monospace font).
   */
  async function format(data, rereadGlyph) {
    const plain = { text: (data.text ?? "").trim(), code: false };
    const lines = rehomeWords(linesOf(data.blocks));
    if (lines.length < 2) return plain;
    const content = stripLineNumbers(lines) ?? lines;
    const pitch = monospacePitch(content);
    if (!pitch) return plain;
    if (rereadGlyph) await rereadMovedGlyphs(content, rereadGlyph);
    const text = layOut(content, pitch)
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/^\n+|\n+$/g, "");
    return { text, code: true };
  }

  return { format };
})();

if (typeof module !== "undefined") module.exports = Ics45cOcrLayout;
