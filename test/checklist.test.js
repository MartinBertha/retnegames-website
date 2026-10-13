// Checks for the checklist ordering rule (docs/hub-spec.md, section 4).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addEntry, moveEntry, normalizeEntries, removeEntry, toggleEntry } from "../public/hub/checklist.js";

const list = (spec) => spec.split(" ").map((token) => ({
  id: token.replace("*", ""),
  text: token.replace("*", ""),
  done: token.endsWith("*")
}));
const show = (entries) => entries.map((entry) => entry.id + (entry.done ? "*" : "")).join(" ");
const invariantHolds = (entries) => entries.findIndex((entry) => entry.done) === -1
  || entries.slice(entries.findIndex((entry) => entry.done)).every((entry) => entry.done);

describe("checklist ordering", () => {
  it("ticking moves an entry to the very bottom", () => {
    assert.equal(show(toggleEntry(list("a b c d* e*"), "b")), "a c d* e* b*");
  });

  it("unticking moves an entry to the top of the unticked group", () => {
    assert.equal(show(toggleEntry(list("a b c* d*"), "d")), "d a b c*");
  });

  it("new entries go to the bottom of the unticked group", () => {
    assert.equal(show(addEntry(list("a b c*"), { id: "n", text: "n" })), "a b n c*");
    assert.equal(show(addEntry([], { id: "n", text: "n" })), "n");
  });

  it("reorders only within the unticked group", () => {
    assert.equal(show(moveEntry(list("a b c d*"), "c", 0)), "c a b d*");
    assert.equal(show(moveEntry(list("a b c d*"), "a", 99)), "b c a d*");
    assert.equal(show(moveEntry(list("a b c d*"), "d", 0)), "a b c d*");
  });

  it("normalises a broken order and removes entries", () => {
    assert.equal(show(normalizeEntries(list("a* b c* d"))), "b d a* c*");
    assert.equal(show(removeEntry(list("a b c*"), "b")), "a c*");
  });

  it("keeps the invariant through any sequence of changes", () => {
    let entries = list("a b c d e");

    for (const id of ["c", "a", "c", "e", "b", "a", "d", "e", "b"]) {
      entries = toggleEntry(entries, id);
      assert.ok(invariantHolds(entries), show(entries));
    }

    entries = moveEntry(addEntry(entries, { id: "z", text: "z" }), "z", 0);
    assert.ok(invariantHolds(entries), show(entries));
  });
});
