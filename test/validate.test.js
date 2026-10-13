// Checks for the hub's card validation (docs/hub-spec.md, section 4 limits).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HttpError } from "../src/hub/http.js";
import { cleanName, validateItem } from "../src/hub/validate.js";

const ID = "a1b2c3d4-1111-4111-8111-11111111111f";
const CHILD = "22222222-2222-4222-8222-222222222222";

const note = (overrides = {}, data = {}) => ({
  id: ID,
  type: "note",
  x: 10,
  y: -20.5,
  w: 240,
  h: 120,
  z: 3,
  color: null,
  data: { text: "Hello", size: "m", ...data },
  ...overrides
});

const folder = (data = {}) => ({
  ...note(),
  type: "folder",
  data: { name: "Art", childBoardId: CHILD, ...data }
});

function rejects(raw, pattern) {
  assert.throws(
    () => validateItem(raw),
    (error) => error instanceof HttpError && error.status === 400 && pattern.test(error.message)
  );
}

describe("validateItem", () => {
  it("accepts a note and serialises only known data", () => {
    const item = validateItem(note({ updatedAt: 5 }, { extra: "dropped" }));
    assert.deepEqual(item.data, { text: "Hello", size: "m" });
    assert.equal(item.dataJson, '{"text":"Hello","size":"m"}');
    assert.equal(item.color, null);
    assert.equal("updatedAt" in item, false);
  });

  it("accepts a folder", () => {
    const item = validateItem(folder({ name: "  Story \n ideas " }));
    assert.deepEqual(item.data, { name: "Story ideas", childBoardId: CHILD });
  });

  it("keeps line breaks and tabs in notes but drops other control characters", () => {
    const item = validateItem(note({}, { text: "a\r\nb\tc\u0000d\u0007e" }));
    assert.equal(item.data.text, "a\nb\tcde");
  });

  it("replaces lone surrogates", () => {
    assert.equal(validateItem(note({}, { text: "x\ud800y" })).data.text, "x�y");
  });

  it("limits note text to 20,000 characters", () => {
    assert.equal(validateItem(note({}, { text: "a".repeat(20_000) })).data.text.length, 20_000);
    rejects(note({}, { text: "a".repeat(20_001) }), /at most 20,000/);
  });

  it("rejects bad note data", () => {
    rejects(note({}, { size: "xl" }), /Invalid note/);
    rejects(note({}, { text: 5 }), /must be text/);
    rejects(note({ data: null }), /Invalid note/);
    rejects(note({ data: [] }), /Invalid note/);
  });

  it("rejects bad folder data", () => {
    rejects(folder({ childBoardId: "nope" }), /Invalid folder/);
    rejects(folder({ name: "   " }), /Name must be/);
    rejects(folder({ name: "x".repeat(101) }), /Name must be/);
  });

  it("rejects unknown types and ids", () => {
    rejects(note({ type: "video" }), /Unsupported/);
    rejects(note({ type: "constructor" }), /Unsupported/);
    rejects(note({ type: "checklist" }), /Unsupported/);
    rejects(note({ id: "x" }), /Invalid card/);
    rejects(note({ id: ID.toUpperCase() }), /Invalid card/);
    rejects(null, /Invalid card/);
  });

  it("enforces position, size and order limits", () => {
    assert.equal(validateItem(note({ x: -1_000_000, y: 1_000_000, w: 40, h: 10_000 })).w, 40);
    rejects(note({ x: 1_000_001 }), /position/);
    rejects(note({ y: Number.NaN }), /position/);
    rejects(note({ x: "5" }), /position/);
    rejects(note({ w: 39 }), /size/);
    rejects(note({ h: 10_001 }), /size/);
    rejects(note({ z: 1.5 }), /order/);
    rejects(note({ z: 2_000_000_000 }), /order/);
  });

  it("accepts no colour until the palette exists", () => {
    assert.equal(validateItem(note({ color: undefined })).color, null);
    rejects(note({ color: "red" }), /colour/);
  });
});

describe("cleanName", () => {
  it("trims and flattens whitespace and control characters", () => {
    assert.equal(cleanName("  Game\tdesign\n"), "Game design");
  });

  it("rejects empty and long names", () => {
    assert.throws(() => cleanName(""), HttpError);
    assert.throws(() => cleanName(42), HttpError);
    assert.throws(() => cleanName("x".repeat(101)), HttpError);
  });
});
