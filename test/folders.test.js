// Checks for shared folders: which boards a delete takes along, what undo
// brings back, and loop detection (src/hub/folders.js).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { boardsToDelete, boardsToRestore, hasLiveLink, reachable } from "../src/hub/folders.js";

// boards: "id:parent" (parent "-" for the root); links: "card:board>child".
function graph(boards, links, deleted = {}) {
  return {
    boards: new Map(boards.split(" ").map((spec) => {
      const [id, parent] = spec.split(":");
      return [id, { id, parentId: parent === "-" ? null : parent, name: id, deletedAt: deleted[id] ?? null }];
    })),
    links: links ? links.split(" ").map((spec) => {
      const [id, rest] = spec.split(":");
      const [boardId, child] = rest.split(">");
      return { id, boardId, child };
    }) : []
  };
}

const sorted = (set) => [...set].sort().join(" ");

describe("shared folders", () => {
  // Home holds folders A and B; A holds C; B holds a copy of C's card.
  const g = () => graph("H:- A:H B:H C:A D:C", "a:H>A b:H>B c1:A>C c2:B>C d:C>D");

  it("deleting a card whose board is still opened elsewhere deletes nothing", () => {
    const links = g().links.filter((link) => link.id !== "c1");
    assert.equal(hasLiveLink(g(), "C", links), true);
  });

  it("deleting the last card takes the board and what only it leads to", () => {
    const links = g().links.filter((link) => link.id !== "a");
    assert.equal(sorted(boardsToDelete(g(), "A", links, "H")), "A");
  });

  it("a board still opened from outside survives a cascade", () => {
    const links = g().links.filter((link) => link.id !== "a" && link.id !== "c2");
    assert.equal(sorted(boardsToDelete(g(), "A", links, "H")), "A C D");
  });

  it("boards with no card at all go with their home", () => {
    const gr = graph("H:- A:H X:A", "a:H>A");
    assert.equal(sorted(boardsToDelete(gr, "A", [], "H")), "A X");
  });

  it("never deletes the root", () => {
    assert.equal(boardsToDelete(g(), "H", [], "H").size, 0);
  });

  it("undo restores exactly the boards deleted together", () => {
    const gr = graph("H:- A:H C:A D:C E:H", "a:H>A c:A>C d:C>D", { A: 5, C: 5, D: 5, E: 5 });
    assert.equal(sorted(boardsToRestore(gr, "A", gr.links)), "A C D");
    const later = graph("H:- A:H C:A", "c:A>C", { A: 5, C: 9 });
    assert.equal(sorted(boardsToRestore(later, "A", later.links)), "A");
  });

  it("finds loops through folder cards", () => {
    assert.equal(reachable(g(), "A", g().links).has("D"), true);
    assert.equal(reachable(g(), "C", g().links).has("A"), false);
    const looped = [...g().links, { id: "x", boardId: "D", child: "A" }];
    assert.equal(reachable(g(), "A", looped).has("D"), true);
  });
});
