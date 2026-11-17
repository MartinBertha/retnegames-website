import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hubTarget, hubUrl, parseHubHash } from "../public/hub/hublinks.js";
import { boardTree, fold, matchRanges, prepareIndex, search, segments, snippet } from "../public/hub/search.js";

const ids = {
  home: "00000000-0000-4000-8000-000000000001",
  game: "00000000-0000-4000-8000-000000000002",
  art: "00000000-0000-4000-8000-000000000003",
  story: "00000000-0000-4000-8000-000000000004",
  card: "00000000-0000-4000-8000-0000000000aa"
};

const data = {
  rootId: ids.home,
  boards: [
    { id: ids.home, parentId: null, name: "Home", updatedAt: 1 },
    { id: ids.game, parentId: ids.home, name: "Tiny Trader", updatedAt: 2 },
    { id: ids.story, parentId: ids.game, name: "Story", updatedAt: 3 },
    { id: ids.art, parentId: ids.game, name: "Art & sprites", updatedAt: 4 }
  ],
  items: [
    { id: "n1", boardId: ids.art, type: "note", title: "Palette ideas", body: "Warm café colours for the market scene.", ref: null, updatedAt: 10 },
    { id: "n2", boardId: ids.story, type: "note", title: "", body: "The trader meets a fox at the market.\nLater, rain.", ref: null, updatedAt: 20 },
    { id: "c1", boardId: ids.game, type: "checklist", title: "Launch", body: "Trailer\nPress kit\nMarket research", ref: null, updatedAt: 5 },
    { id: "f1", boardId: ids.game, type: "folder", title: "Art & sprites", body: "", ref: ids.art, updatedAt: 6 },
    { id: "x1", boardId: "missing-board", type: "note", title: "Orphan market", body: "", ref: null, updatedAt: 7 }
  ]
};

const index = prepareIndex(data);

describe("search", () => {
  it("folds case and accents", () => {
    assert.equal(fold("Café ÜBER"), "cafe uber");
  });

  it("finds cards by their words, in any order, ignoring accents", () => {
    const found = search(index, "MARKET cafe");

    assert.deepEqual(found.cards.map((card) => card.item.id), ["n1"]);
  });

  it("ranks a title match above words in the text", () => {
    const found = search(index, "market");

    // c1 has "Market research" in its items, n1 and n2 in their text; none
    // in a title, so the most recently changed comes first.
    assert.deepEqual(found.cards.map((card) => card.item.id), ["n2", "n1", "c1"]);
    assert.equal(search(index, "launch").cards[0].inTitle, true);
  });

  it("finds boards by name, and by the boards they're in", () => {
    const found = search(index, "art");

    assert.equal(found.boards[0].board.id, ids.art);
    assert.ok(search(index, "trader story").boards.some((result) => result.board.id === ids.story));
  });

  it("doesn't list folder cards (their boards are found instead) or cards on unknown boards", () => {
    const found = search(index, "sprites");

    assert.deepEqual(found.cards, []);
    assert.equal(search(index, "orphan").cards.length, 0);
  });

  it("finds nothing for an empty query", () => {
    assert.deepEqual(search(index, "   "), { boards: [], cards: [], moreCards: 0 });
  });

  it("marks matches in the original text, accents included", () => {
    const text = "Warm Café colours";
    const ranges = matchRanges(text, ["cafe"]);

    assert.deepEqual(ranges, [[5, 9]]);
    assert.deepEqual(segments(text, ranges), [
      { text: "Warm ", mark: false },
      { text: "Café", mark: true },
      { text: " colours", mark: false }
    ]);
  });

  it("cuts a snippet around the first match", () => {
    const long = `${"word ".repeat(30)}the fox jumps ${"more ".repeat(40)}`;
    const piece = snippet(long, ["fox"], { before: 10, length: 40 });

    assert.ok(piece.text.startsWith("…"));
    assert.ok(piece.text.endsWith("…"));
    const [from, to] = piece.ranges[0];
    assert.equal(piece.text.slice(from, to), "fox");
  });

  it("lists the boards as a tree, children by name", () => {
    const rows = boardTree(index).map(({ board, depth }) => [board.name, depth]);

    assert.deepEqual(rows, [["Home", 0], ["Tiny Trader", 1], ["Art & sprites", 2], ["Story", 2]]);
    assert.deepEqual(index.boards.get(ids.story).path, ["Home", "Tiny Trader"]);
  });

  it("labels cards by their title or first line", () => {
    assert.equal(index.itemsById.get("n2").label, "The trader meets a fox at the market.");
    assert.equal(index.itemsById.get("c1").label, "Launch");
  });
});

describe("hub links", () => {
  const origin = "https://retne.games";

  it("reads a board or card from the address", () => {
    assert.deepEqual(parseHubHash(`#/b/${ids.art}`), { boardId: ids.art, cardId: null });
    assert.deepEqual(parseHubHash(`#/b/${ids.art}/c/${ids.card}`), { boardId: ids.art, cardId: ids.card });
    assert.equal(parseHubHash("#/b/nope"), null);
    assert.equal(parseHubHash(`#/b/${ids.art}/c/`), null);
  });

  it("recognises links into this hub only", () => {
    const url = hubUrl({ boardId: ids.art, cardId: ids.card }, origin);

    assert.equal(url, `https://retne.games/hub/#/b/${ids.art}/c/${ids.card}`);
    assert.deepEqual(hubTarget(url, origin), { boardId: ids.art, cardId: ids.card });
    assert.equal(hubTarget(url, "https://example.com"), null);
    assert.equal(hubTarget(`https://retne.games/elsewhere/#/b/${ids.art}`, origin), null);
    assert.equal(hubTarget("not a url", origin), null);
  });
});
