import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mergeCards, resolveConflict, same } from "../public/hub/merge.js";

let counter = 0;
const newId = () => `new-${++counter}`;

const note = (data, extra = {}) => ({
  id: "n1",
  type: "note",
  x: 0,
  y: 0,
  w: 240,
  h: 120,
  z: 1,
  color: null,
  data: { title: "", text: "", size: "m", ...data },
  ...extra
});

const checklist = (entries, extra = {}) => ({
  id: "c1",
  type: "checklist",
  x: 0,
  y: 0,
  w: 264,
  h: 144,
  z: 1,
  color: null,
  data: { title: "Todo", entries },
  ...extra
});

const entry = (id, text, done = false) => ({ id, text, done });

describe("same", () => {
  it("treats missing and empty values as equal", () => {
    assert.equal(same(undefined, ""), true);
    assert.equal(same({ bold: false }, {}), true);
    assert.equal(same([], undefined), true);
  });

  it("ignores surrounding spaces the server trims", () => {
    assert.equal(same("Hello ", "Hello"), true);
    assert.equal(same("a\r\nb", "a\nb"), true);
    assert.equal(same("Hello", "Help"), false);
  });

  it("compares objects key by key, whatever the order", () => {
    assert.equal(same({ a: 1, b: { c: "x" } }, { b: { c: "x" }, a: 1 }), true);
    assert.equal(same({ a: 1 }, { a: 2 }), false);
  });
});

describe("mergeCards", () => {
  it("takes a move from here and a text edit from there", () => {
    const base = note({ text: "one" });
    const local = note({ text: "one" }, { x: 48, y: 24 });
    const server = note({ text: "one two" });

    const { item, conflicts } = mergeCards(base, local, server);

    assert.equal(item.x, 48);
    assert.equal(item.y, 24);
    assert.equal(item.data.text, "one two");
    assert.equal(conflicts.size, 0);
  });

  it("merges style changes made on both sides key by key", () => {
    const base = note({ text: "x" });
    const local = note({ text: "x", style: { title: { bold: true } } });
    const server = note({ text: "x", style: { body: { italic: true } } });

    const { item, conflicts } = mergeCards(base, local, server);

    assert.deepEqual(item.data.style, { title: { bold: true }, body: { italic: true } });
    assert.equal(conflicts.size, 0);
  });

  it("reports text changed on both sides", () => {
    const { item, conflicts } = mergeCards(note({ text: "a" }), note({ text: "b" }), note({ text: "c" }));

    assert.equal(item.data.text, "b");
    assert.deepEqual([...conflicts], ["text"]);
  });

  it("lets this device win a colour both changed, without a clash on content", () => {
    const { item, conflicts } = mergeCards(note({}), note({}, { color: "red" }), note({}, { color: "blue" }));

    assert.equal(item.color, "red");
    assert.equal(conflicts.has("text"), false);
  });

  it("merges checklist items one by one", () => {
    const base = checklist([entry("a", "milk"), entry("b", "eggs")]);
    // Here: tick "milk", add "bread". There: rename "eggs", add "jam".
    const local = checklist([entry("b", "eggs"), entry("c", "bread"), entry("a", "milk", true)]);
    const server = checklist([entry("a", "milk"), entry("b", "6 eggs"), entry("d", "jam")]);

    const { item, conflicts } = mergeCards(base, local, server);

    assert.deepEqual(item.data.entries, [
      entry("b", "6 eggs"),
      entry("c", "bread"),
      entry("d", "jam"),
      entry("a", "milk", true)
    ]);
    assert.equal(conflicts.size, 0);
  });

  it("drops an item removed on one side and unchanged on the other", () => {
    const base = checklist([entry("a", "milk"), entry("b", "eggs")]);
    const local = checklist([entry("a", "milk")]);
    const server = checklist([entry("a", "milk"), entry("b", "eggs")], { x: 24 });

    const { item } = mergeCards(base, local, server);

    assert.deepEqual(item.data.entries, [entry("a", "milk")]);
    assert.equal(item.x, 24);
  });

  it("keeps an item removed here but changed there", () => {
    const base = checklist([entry("a", "milk"), entry("b", "eggs")]);
    const local = checklist([entry("a", "milk")]);
    const server = checklist([entry("a", "milk"), entry("b", "eggs", true)]);

    const { item } = mergeCards(base, local, server);

    assert.deepEqual(item.data.entries, [entry("a", "milk"), entry("b", "eggs", true)]);
  });

  it("reports the same item's text changed on both sides", () => {
    const base = checklist([entry("a", "milk")]);
    const { conflicts } = mergeCards(base, checklist([entry("a", "oat milk")]), checklist([entry("a", "soy milk")]));

    assert.deepEqual([...conflicts], ["entries"]);
  });
});

describe("resolveConflict", () => {
  it("merges without a copy when nothing clashed", () => {
    const result = resolveConflict(
      { base: note({ text: "a" }), local: note({ text: "a" }, { x: 96 }), server: note({ text: "ab" }), deleted: false },
      { newId, z: 5 }
    );

    assert.equal(result.outcome, "merged");
    assert.equal(result.copy, null);
    assert.equal(result.item.x, 96);
    assert.equal(result.item.data.text, "ab");
  });

  it("keeps the other version as a copy when the text clashes", () => {
    const result = resolveConflict(
      { base: note({ text: "a" }), local: note({ text: "mine" }), server: note({ text: "theirs" }), deleted: false },
      { newId, z: 7 }
    );

    assert.equal(result.outcome, "copied");
    assert.equal(result.item.data.text, "mine");
    assert.equal(result.copy.data.text, "theirs");
    assert.notEqual(result.copy.id, "n1");
    assert.equal(result.copy.z, 7);
    // On the grid, just right of the card.
    assert.equal(result.copy.x, 264);
    assert.equal(result.copy.y, 0);
  });

  it("gives a copied checklist new item ids", () => {
    const base = checklist([entry("a", "milk")]);
    const result = resolveConflict(
      { base, local: checklist([entry("a", "oat milk")]), server: checklist([entry("a", "soy milk")]), deleted: false },
      { newId, z: 2 }
    );

    assert.equal(result.outcome, "copied");
    assert.notEqual(result.copy.data.entries[0].id, "a");
    assert.equal(result.copy.data.entries[0].text, "soy milk");
  });

  it("lets a delete there stand when only the position changed here", () => {
    const result = resolveConflict(
      { base: note({ text: "a" }), local: note({ text: "a" }, { x: 48 }), server: note({ text: "a" }), deleted: true },
      { newId }
    );

    assert.equal(result.outcome, "removed");
    assert.equal(result.item, null);
  });

  it("keeps a card deleted there whose text changed here", () => {
    const local = note({ text: "edited" });
    const result = resolveConflict(
      { base: note({ text: "a" }), local, server: note({ text: "a" }), deleted: true },
      { newId }
    );

    assert.equal(result.outcome, "kept");
    assert.deepEqual(result.item, local);
  });

  it("keeps the card being edited as it is, with the other text as a copy", () => {
    const local = note({ title: "T", text: "typing" });
    const result = resolveConflict(
      { base: note({ title: "T", text: "a" }), local, server: note({ title: "T2", text: "a" }), deleted: false, editing: true },
      { newId, z: 3 }
    );

    assert.equal(result.outcome, "copied");
    assert.deepEqual(result.item, local);
    assert.equal(result.copy.data.title, "T2");
  });

  it("doesn't copy for a clash in a folder's name: this device wins", () => {
    const folder = (name) => ({
      id: "f1",
      type: "folder",
      x: 0,
      y: 0,
      w: 168,
      h: 144,
      z: 1,
      color: null,
      data: { name, childBoardId: "b1" }
    });
    const result = resolveConflict(
      { base: folder("Art"), local: folder("Art 2"), server: folder("Artwork"), deleted: false },
      { newId }
    );

    assert.equal(result.outcome, "merged");
    assert.equal(result.item.data.name, "Art 2");
  });
});
