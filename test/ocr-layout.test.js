// Unit tests for src/ocr-layout.js against synthetic Tesseract results.
const test = require("node:test");
const assert = require("node:assert/strict");
const OcrLayout = require("../src/ocr-layout.js");

const PITCH = 13.5;
const GUTTER_X = 60;
const CODE_X = 90;

/**
 * Builds a Tesseract-like result for a monospace screenshot. Each line is a
 * list of [text, column] words; `number` adds a gutter word on the left.
 */
function screenshot(lines, { numbered = false, left = CODE_X, text = "" } = {}) {
  const word = (value, x0) => ({ text: value, bbox: { x0, x1: x0 + value.length * PITCH - 2 } });
  const tesseractLines = lines.map((words, index) => {
    const y0 = 20 + index * 24;
    const placed = words.map(([value, column]) => word(value, left + column * PITCH));
    if (numbered) placed.unshift(word(String(index + 1), GUTTER_X));
    return { bbox: { y0 }, words: placed };
  });
  return { text, blocks: [{ paragraphs: [{ lines: tesseractLines }] }] };
}

test("removes a line-number gutter and restores indentation", () => {
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
  const result = OcrLayout.format(data);
  assert.equal(result.code, true);
  assert.equal(result.text, "class Stack {\n    int _top;\n\n    // adds c\n    void push(char c);\n};");
});

test("handles numbers glued to code and misread indent guides", () => {
  const data = screenshot(
    [
      [["int", 0], ["main()", 4], ["{", 11]],
      [["cout", 4], ["<<", 9], ["x", 12]],
      [[")", 0], ["<<", 9], ["endl;", 12]],
      [["}", 0]],
    ],
    { numbered: true },
  );
  // Line 3: the editor's indent guide was read as ")" at column 0.
  // Line 4: OCR merged the line number with the brace ("4}").
  const last = data.blocks[0].paragraphs[0].lines[3];
  last.words = [{ text: "4}", bbox: { x0: GUTTER_X, x1: GUTTER_X + 2 * PITCH } }];
  const result = OcrLayout.format(data);
  assert.equal(result.text, "int main() {\n    cout << x\n         << endl;\n}");
});

test("lays out monospace output without a gutter", () => {
  const data = screenshot([
    [["$", 0], ["./build/hw", 2]],
    [["make", 0], ["#", 14], ["build", 16], ["everything", 22]],
    [["make", 0], ["test", 5], ["#", 14], ["run", 16], ["tests", 20]],
  ]);
  const result = OcrLayout.format(data);
  assert.equal(result.code, true);
  assert.equal(result.text, "$ ./build/hw\nmake          # build everything\nmake test     # run tests");
});

test("keeps Tesseract's text for proportional fonts", () => {
  // Word starts that do not fit one character pitch: a chart in a proportional font.
  const word = (text, x0) => ({ text, bbox: { x0, x1: x0 + text.length * 9 } });
  const data = {
    text: "Grade Weighting\nFinal Exam\n36.0%\n",
    blocks: [{ paragraphs: [{ lines: [
      { bbox: { y0: 10 }, words: [word("Grade", 10), word("Weighting", 80)] },
      { bbox: { y0: 40 }, words: [word("Final", 10), word("Exam", 52)] },
      { bbox: { y0: 70 }, words: [word("Reading", 300), word("Quizzes", 395), word("&", 460), word("Homework", 478)] },
    ] }] }],
  };
  assert.deepEqual(OcrLayout.format(data), { text: "Grade Weighting\nFinal Exam\n36.0%", code: false });
});

test("falls back to plain text when there are no word boxes", () => {
  assert.deepEqual(OcrLayout.format({ text: "  Hello, World!\n" }), { text: "Hello, World!", code: false });
});
