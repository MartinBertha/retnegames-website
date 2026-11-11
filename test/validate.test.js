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
    assert.deepEqual(item.data, { title: "", text: "Hello", size: "m" });
    assert.equal(item.dataJson, '{"title":"","text":"Hello","size":"m"}');
    assert.equal(item.color, null);
    assert.equal("updatedAt" in item, false);
  });

  it("gives notes an optional one-line title", () => {
    assert.equal(validateItem(note({}, { title: "  Big\nidea " })).data.title, "Big idea");
    assert.equal(validateItem(note({}, { title: undefined })).data.title, "");
    rejects(note({}, { title: "x".repeat(101) }), /at most 100/);
    rejects(note({}, { title: 7 }), /Title must be text/);
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

  it("accepts palette colours or none", () => {
    assert.equal(validateItem(note({ color: undefined })).color, null);
    assert.equal(validateItem(note({ color: "teal" })).color, "teal");
    rejects(note({ color: "hotpink" }), /colour/);
    rejects(note({ color: "#ff0000" }), /colour/);
  });
});

const ENTRY = (n, done = false, text = `Item ${n}`) => ({
  id: `0000000${n}-0000-4000-8000-000000000000`,
  text,
  done
});

describe("checklists", () => {
  const checklist = (data) => ({ ...note(), type: "checklist", data });

  it("keeps unticked entries above ticked ones, each group in order", () => {
    const item = validateItem(checklist({
      title: "Todo",
      entries: [ENTRY(1, true), ENTRY(2), ENTRY(3, true), ENTRY(4)]
    }));
    assert.deepEqual(item.data.entries.map((entry) => entry.text), ["Item 2", "Item 4", "Item 1", "Item 3"]);
  });

  it("allows an empty title and empty entries", () => {
    const item = validateItem(checklist({ entries: [ENTRY(1, false, "")] }));
    assert.deepEqual(item.data, { title: "", entries: [{ id: ENTRY(1).id, text: "", done: false }] });
  });

  it("flattens entry text to one line", () => {
    const item = validateItem(checklist({ title: "", entries: [ENTRY(1, false, " a\nb ")] }));
    assert.equal(item.data.entries[0].text, "a b");
  });

  it("enforces checklist limits", () => {
    const many = Array.from({ length: 201 }, (_, i) => ({
      id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
      text: "",
      done: false
    }));
    rejects(checklist({ title: "", entries: many }), /at most 200/);
    rejects(checklist({ title: "", entries: [ENTRY(1, false, "x".repeat(501))] }), /at most 500/);
    rejects(checklist({ title: "x".repeat(101), entries: [] }), /at most 100/);
    rejects(checklist({ title: "", entries: [ENTRY(1), ENTRY(1)] }), /Invalid checklist item/);
    rejects(checklist({ title: "", entries: [{ ...ENTRY(1), done: "yes" }] }), /Invalid checklist item/);
    rejects(checklist({ title: "" }), /Invalid checklist/);
  });
});

describe("links, images and sections", () => {
  const link = (data) => ({ ...note(), type: "link", data });

  it("accepts http(s) links and normalises them", () => {
    assert.equal(validateItem(link({ url: " https://Example.com/a b ", title: "" })).data.url, "https://example.com/a%20b");
    assert.equal(validateItem(link({ url: "http://example.com", title: "Ex" })).data.title, "Ex");
  });

  it("rejects other schemes and overlong links", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "ftp://x.org", "//example.com", "example.com"]) {
      rejects(link({ url, title: "" }), /link|http/i);
    }

    rejects(link({ url: `https://example.com/${"a".repeat(2048)}`, title: "" }), /Invalid link/);
    rejects(link({ title: "" }), /Invalid link/);
  });

  it("accepts a link card with no address yet", () => {
    assert.equal(validateItem(link({ url: "", title: "" })).data.url, "");
    assert.equal(validateItem(link({ url: "   ", title: "Later" })).data.url, "");
  });

  it("validates images and sections", () => {
    const image = validateItem({ ...note(), type: "image", data: { fileId: CHILD, caption: "Moodboard" } });
    assert.deepEqual(image.data, { fileId: CHILD, caption: "Moodboard" });
    rejects({ ...note(), type: "image", data: { fileId: "x" } }, /Invalid image/);

    const section = validateItem({ ...note(), type: "section", data: { title: "Act 1" } });
    assert.deepEqual(section.data, { title: "Act 1" });
    rejects({ ...note(), type: "section", data: { title: "x".repeat(101) } }, /at most 100/);
  });
});

describe("line connectors", () => {
  const CARD_A = "33333333-3333-4333-8333-333333333333";
  const CARD_B = "44444444-4444-4444-8444-444444444444";
  const line = (data, overrides = {}) => ({
    ...note(),
    type: "connector",
    x: 0,
    y: 48,
    w: 120,
    h: 0,
    data,
    ...overrides
  });
  const free = { start: { x: 0, y: 48 }, end: { x: 120, y: 48 } };

  it("accepts a flat line, which no card may be", () => {
    const item = validateItem(line(free));

    assert.equal(item.h, 0);
    assert.deepEqual(item.data, free);
    rejects(note({ h: 0 }), /Invalid card size/);
  });

  it("keeps the card and side of an attached end, and drops unknown keys", () => {
    const item = validateItem(line({
      start: { x: 0, y: 48, item: CARD_A, side: "right", extra: 1 },
      end: { x: 120, y: 48 }
    }));

    assert.deepEqual(item.data.start, { x: 0, y: 48, item: CARD_A, side: "right" });
    assert.deepEqual(item.data.end, { x: 120, y: 48 });
  });

  it("allows ends on two different cards, and many lines on one card", () => {
    const item = validateItem(line({
      start: { x: 0, y: 48, item: CARD_A, side: "right" },
      end: { x: 120, y: 48, item: CARD_B, side: "left" }
    }));

    assert.equal(item.data.end.item, CARD_B);
  });

  it("rejects both ends on one card", () => {
    rejects(line({
      start: { x: 0, y: 48, item: CARD_A, side: "right" },
      end: { x: 120, y: 48, item: CARD_A, side: "left" }
    }), /can't join a card to itself/);
  });

  it("rejects bad attachments and positions", () => {
    rejects(line({ start: { x: 0, y: 48, item: CARD_A }, end: free.end }), /Invalid line attachment/);
    rejects(line({ start: { x: 0, y: 48, item: "nope", side: "top" }, end: free.end }), /Invalid line attachment/);
    rejects(line({ start: { x: 0, y: 48, item: CARD_A, side: "middle" }, end: free.end }), /Invalid line attachment/);
    rejects(line({ start: { x: 0, y: "48" }, end: free.end }), /Invalid line position/);
    rejects(line({ start: { x: 2_000_000, y: 0 }, end: free.end }), /Invalid line position/);
    rejects(line({ start: free.start }), /Invalid line/);
    rejects(line("free"), /Invalid line/);
  });

  it("allows a box as long as the coordinate range, and no longer", () => {
    assert.equal(validateItem(line(free, { w: 2_000_000 })).w, 2_000_000);
    rejects(line(free, { w: 2_000_001 }), /Invalid card size/);
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

describe("right-angle line connectors", () => {
  const CARD = "33333333-3333-4333-8333-333333333333";
  const line = (data) => ({ ...note(), type: "connector", x: 0, y: 0, w: 120, h: 48, data });
  const ends = { start: { x: 0, y: 0, dir: "right" }, end: { x: 120, y: 48, dir: "left" } };

  it("keeps the type and the direction of each end", () => {
    const item = validateItem(line({ shape: "elbow", ...ends, extra: 1 }));

    assert.deepEqual(item.data, { shape: "elbow", ...ends });
  });

  it("doesn't store the straight type, and accepts a line without directions", () => {
    assert.deepEqual(validateItem(line({ shape: "straight", start: { x: 0, y: 0 }, end: { x: 5, y: 5 } })).data, {
      start: { x: 0, y: 0 },
      end: { x: 5, y: 5 }
    });
  });

  it("keeps the direction of an attached end next to its card and side", () => {
    const item = validateItem(line({
      shape: "elbow",
      start: { x: 0, y: 0, dir: "down", item: CARD, side: "bottom" },
      end: ends.end
    }));

    assert.deepEqual(item.data.start, { x: 0, y: 0, dir: "down", item: CARD, side: "bottom" });
  });

  it("rejects an unknown type or direction", () => {
    rejects(line({ shape: "curvy", ...ends }), /Invalid line type/);
    rejects(line({ shape: "elbow", start: { ...ends.start, dir: "north" }, end: ends.end }), /Invalid line direction/);
    rejects(line({ shape: "elbow", start: { ...ends.start, dir: 3 }, end: ends.end }), /Invalid line direction/);
  });
});
