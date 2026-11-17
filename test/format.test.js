import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatLine, lineHeading, trimUrl } from "../public/hub/format.js";
import { HttpError } from "../src/hub/http.js";
import { validateItem } from "../src/hub/validate.js";

// [text, "flags"] pairs, URLs as "URL:<address>".
const pieces = (line) => formatLine(line).map((token) => [
  token.type === "url" ? `URL:${token.text}` : token.text,
  ["bold", "italic", "strike", "code"].filter((flag) => token[flag]).join("+")
]);

describe("note formatting", () => {
  it("leaves plain text alone", () => {
    assert.deepEqual(pieces("Just words, 100% plain."), [["Just words, 100% plain.", ""]]);
  });

  it("reads bold, italic, strike and code", () => {
    assert.deepEqual(pieces("**b** *i* _u_ ~~s~~ `c`"), [
      ["b", "bold"], [" ", ""], ["i", "italic"], [" ", ""], ["u", "italic"], [" ", ""], ["s", "strike"], [" ", ""], ["c", "code"]
    ]);
  });

  it("nests italic inside bold", () => {
    assert.deepEqual(pieces("**big *and slanted* text**"), [
      ["big ", "bold"], ["and slanted", "bold+italic"], [" text", "bold"]
    ]);
  });

  it("shows code as typed", () => {
    assert.deepEqual(pieces("`a *b* **c**`"), [["a *b* **c**", "code"]]);
  });

  it("ignores markers that aren't around words", () => {
    assert.deepEqual(pieces("2 * 3 * 4"), [["2 * 3 * 4", ""]]);
    assert.deepEqual(pieces("snake_case_name and a*b*c"), [["snake_case_name and a*b*c", ""]]);
    assert.deepEqual(pieces("** not bold **"), [["** not bold **", ""]]);
  });

  it("keeps web addresses whole, even with markers in them", () => {
    assert.deepEqual(pieces("see https://example.com/a_b_c."), [["see ", ""], ["URL:https://example.com/a_b_c", ""], [".", ""]]);
    assert.deepEqual(pieces("**https://example.com**"), [["URL:https://example.com", "bold"]]);
    assert.equal(trimUrl("https://example.com/a_(b))."), "https://example.com/a_(b)");
  });

  it("reads headings", () => {
    assert.deepEqual(lineHeading("# Plan"), { level: 1, text: "Plan" });
    assert.deepEqual(lineHeading("### Small"), { level: 3, text: "Small" });
    assert.equal(lineHeading("#1 priority"), null);
    assert.equal(lineHeading("#### Too deep"), null);
    assert.equal(lineHeading("#   "), null);
  });
});

describe("locked cards", () => {
  const note = (data) => ({
    id: "a1b2c3d4-1111-4111-8111-11111111111f",
    type: "note",
    x: 0,
    y: 0,
    w: 240,
    h: 120,
    z: 1,
    color: null,
    data: { title: "", text: "Hi", size: "m", ...data }
  });

  it("stores a lock only when on", () => {
    assert.equal(validateItem(note({ locked: true })).data.locked, true);
    assert.equal("locked" in validateItem(note({ locked: false })).data, false);
    assert.equal("locked" in validateItem(note({})).data, false);
  });

  it("rejects a lock that isn't true or false", () => {
    assert.throws(() => validateItem(note({ locked: "yes" })), (error) => error instanceof HttpError && error.status === 400);
  });

  it("keeps a checklist's hidden ticked items", () => {
    const checklist = {
      id: "a1b2c3d4-1111-4111-8111-11111111112f",
      type: "checklist",
      x: 0,
      y: 0,
      w: 264,
      h: 144,
      z: 1,
      color: null,
      data: { title: "", entries: [], style: { hideDone: true } }
    };

    assert.deepEqual(validateItem(checklist).data.style, { hideDone: true });
  });
});
