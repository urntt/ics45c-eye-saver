// Unit tests for src/ocr-layout.js against synthetic Tesseract results.
const test = require("node:test");
const assert = require("node:assert/strict");
const OcrLayout = require("../src/ocr-layout.js");

const PITCH = 13.5;
const GUTTER_X = 60;
const CODE_X = 90;
const LINE_HEIGHT = 24;
const GLYPH_HEIGHT = 17;

const rowTop = (row) => 20 + row * LINE_HEIGHT;

/** A Tesseract word at pixel `x0` on text row `row`. */
function word(text, x0, row) {
  return { text, bbox: { x0, x1: x0 + text.length * PITCH - 2, y0: rowTop(row), y1: rowTop(row) + GLYPH_HEIGHT } };
}

/**
 * Builds a Tesseract-like result for a monospace screenshot. Each line is a
 * list of [text, column] words; `numbered` adds a gutter word on the left.
 */
function screenshot(lines, { numbered = false, text = "" } = {}) {
  const tesseractLines = lines.map((words, row) => {
    const placed = words.map(([value, column]) => word(value, CODE_X + column * PITCH, row));
    if (numbered) placed.unshift(word(String(row + 1), GUTTER_X, row));
    return { bbox: { y0: rowTop(row) }, words: placed };
  });
  return { text, blocks: [{ paragraphs: [{ lines: tesseractLines }] }] };
}

const linesIn = (data) => data.blocks[0].paragraphs[0].lines;

test("removes a line-number gutter and restores indentation", async () => {
  const data = screenshot(
    [
      [["class", 0], ["Stack", 6], ["{", 12]],
      [["int", 4], ["_top;", 8]],
      [],
      [["//", 4], ["adds", 7], ["c", 12]],
      [["void", 4], ["push(char", 9], ["c);", 19]],
      [["};", 0]],
    ],
    { numbered: true },
  );
  const result = await OcrLayout.format(data);
  assert.equal(result.code, true);
  assert.equal(result.text, "class Stack {\n    int _top;\n\n    // adds c\n    void push(char c);\n};");
});

test("puts a lone brace back on its own line and re-reads it", async () => {
  // Tesseract attached the "}" of line 4 to line 3 and read it as ")".
  const data = screenshot(
    [
      [["int", 0], ["main()", 4], ["{", 11]],
      [["cout", 4], ["<<", 9], ["x", 12]],
      [["<<", 9], ["endl;", 12]],
      [],
    ],
    { numbered: true },
  );
  const stray = word(")", CODE_X, 3);
  linesIn(data)[2].words.splice(1, 0, stray);

  const reread = [];
  const result = await OcrLayout.format(data, async (box) => {
    reread.push(box);
    return "}\n";
  });
  assert.equal(result.text, "int main() {\n    cout << x\n         << endl;\n}");
  assert.deepEqual(reread, [stray.bbox], "only the moved glyph is re-read");

  const withoutReread = await OcrLayout.format(data);
  assert.equal(withoutReread.text, "int main() {\n    cout << x\n         << endl;\n)", "still moved without a re-reader");
});

test("splits a line number that OCR glued to the code", async () => {
  const data = screenshot(
    [
      [["int", 0], ["main()", 4], ["{", 11]],
      [["cout", 4], ["<<", 9], ["x;", 12]],
      [["return", 4], ["0;", 11]],
      [["}", 0]],
    ],
    { numbered: true },
  );
  linesIn(data)[3].words = [word("4}", GUTTER_X, 3)];
  assert.equal((await OcrLayout.format(data)).text, "int main() {\n    cout << x;\n    return 0;\n}");
});

test("lays out monospace output without a gutter", async () => {
  const data = screenshot([
    [["$", 0], ["./build/hw", 2]],
    [["make", 0], ["#", 14], ["build", 16], ["everything", 22]],
    [["make", 0], ["test", 5], ["#", 14], ["run", 16], ["tests", 20]],
  ]);
  const result = await OcrLayout.format(data);
  assert.equal(result.code, true);
  assert.equal(result.text, "$ ./build/hw\nmake          # build everything\nmake test     # run tests");
});

test("keeps Tesseract's text for proportional fonts", async () => {
  // Word starts that do not fit one character pitch: a chart in a proportional font.
  const proportional = (text, x0, row) => ({ text, bbox: { x0, x1: x0 + text.length * 9, y0: rowTop(row), y1: rowTop(row) + GLYPH_HEIGHT } });
  const data = {
    text: "Grade Weighting\nFinal Exam\n36.0%\n",
    blocks: [{ paragraphs: [{ lines: [
      { bbox: { y0: rowTop(0) }, words: [proportional("Grade", 10, 0), proportional("Weighting", 80, 0)] },
      { bbox: { y0: rowTop(1) }, words: [proportional("Final", 10, 1), proportional("Exam", 52, 1)] },
      { bbox: { y0: rowTop(2) }, words: [proportional("Reading", 300, 2), proportional("Quizzes", 395, 2), proportional("&", 460, 2), proportional("Homework", 478, 2)] },
    ] }] }],
  };
  assert.deepEqual(await OcrLayout.format(data), { text: "Grade Weighting\nFinal Exam\n36.0%", code: false });
});

test("falls back to plain text when there are no word boxes", async () => {
  assert.deepEqual(await OcrLayout.format({ text: "  Hello, World!\n" }), { text: "Hello, World!", code: false });
});
