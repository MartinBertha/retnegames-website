// Checks for the line connector geometry (docs/hub-spec.md, section 6).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MIN_LENGTH,
  attachedCard,
  boundsOf,
  cardsNear,
  endPosition,
  hotspotPoint,
  keepApart,
  nearestHotspot,
  segmentTouchesRect
} from "../public/hub/connectors.js";
import { makePayload, parsePayload } from "../public/hub/clipboard.js";

const card = (id, x, y, w, h, extra = {}) => ({ id, type: "note", x, y, w, h, z: 1, ...extra });
const board = (...items) => new Map(items.map((item) => [item.id, item]));

describe("hotspots", () => {
  const rect = { x: 100, y: 200, w: 240, h: 120 };

  it("sit in the middle of each side", () => {
    assert.deepEqual(hotspotPoint(rect, "top"), { x: 220, y: 200 });
    assert.deepEqual(hotspotPoint(rect, "bottom"), { x: 220, y: 320 });
    assert.deepEqual(hotspotPoint(rect, "left"), { x: 100, y: 260 });
    assert.deepEqual(hotspotPoint(rect, "right"), { x: 340, y: 260 });
  });
});

describe("line ends", () => {
  const items = board(card("a", 0, 0, 100, 50), { id: "l", type: "connector", x: 0, y: 0, w: 0, h: 0, z: 2 });

  it("sit on their card's hotspot when attached, else at their own point", () => {
    assert.deepEqual(endPosition({ x: 5, y: 5, item: "a", side: "right" }, items), { x: 100, y: 25 });
    assert.deepEqual(endPosition({ x: 5, y: 6 }, items), { x: 5, y: 6 });
  });

  it("fall back to their point when the card is gone, or is a line", () => {
    assert.equal(attachedCard({ x: 5, y: 6, item: "gone", side: "top" }, items), null);
    assert.equal(attachedCard({ x: 5, y: 6, item: "l", side: "top" }, items), null);
    assert.deepEqual(endPosition({ x: 5, y: 6, item: "gone", side: "top" }, items), { x: 5, y: 6 });
  });

  it("have a box that is flat for a straight line", () => {
    assert.deepEqual(boundsOf({ x: 120, y: 48 }, { x: 0, y: 48 }), { x: 0, y: 48, w: 120, h: 0 });
    assert.deepEqual(boundsOf({ x: 10, y: 50 }, { x: 40, y: 20 }), { x: 10, y: 20, w: 30, h: 30 });
  });
});

describe("nearestHotspot", () => {
  const items = board(
    card("a", 0, 0, 240, 120),
    card("b", 400, 0, 240, 120),
    { id: "l", type: "connector", x: 0, y: 0, w: 0, h: 0, z: 5 }
  );

  it("finds the hotspot within the radius", () => {
    assert.deepEqual(nearestHotspot(items, { x: 238, y: 62 }, 20), { item: "a", side: "right", x: 240, y: 60 });
    assert.deepEqual(nearestHotspot(items, { x: 118, y: 3 }, 20), { item: "a", side: "top", x: 120, y: 0 });
  });

  it("finds nothing farther away, or over the middle of a card", () => {
    assert.equal(nearestHotspot(items, { x: 300, y: 300 }, 20), null);
    assert.equal(nearestHotspot(items, { x: 120, y: 60 }, 20), null);
  });

  it("skips one card, so a line can't join a card to itself", () => {
    assert.equal(nearestHotspot(items, { x: 238, y: 62 }, 20, { skipId: "a" }), null);
    assert.equal(nearestHotspot(items, { x: 238, y: 62 }, 200, { skipId: "a" }).item, "b");
    assert.equal(nearestHotspot(items, { x: 238, y: 62 }, 200, { skipId: "a" }).side, "left");
  });

  it("skips a hotspot that would leave the line too short", () => {
    const far = { x: 240, y: 60 };
    assert.equal(nearestHotspot(items, { x: 238, y: 62 }, 20, { awayFrom: far }), null);
    assert.equal(nearestHotspot(items, { x: 238, y: 62 }, 20, { awayFrom: { x: 240, y: 60 + MIN_LENGTH } }).item, "a");
  });

  it("never picks a line, and prefers the card in front on a tie", () => {
    const stacked = board(card("low", 0, 0, 100, 100, { z: 1 }), card("high", 0, 0, 100, 100, { z: 9 }));
    assert.equal(nearestHotspot(stacked, { x: 50, y: 0 }, 10).item, "high");
    assert.equal(nearestHotspot(board({ id: "l", type: "connector", x: 0, y: 0, w: 0, h: 0, z: 1 }), { x: 0, y: 0 }, 50), null);
  });
});

describe("cardsNear", () => {
  const items = board(card("a", 0, 0, 100, 100), card("b", 500, 0, 100, 100));

  it("lists the cards within reach of a point, but not the skipped one", () => {
    assert.deepEqual(cardsNear(items, { x: 120, y: 50 }, 30).map((c) => c.id), ["a"]);
    assert.deepEqual(cardsNear(items, { x: 120, y: 50 }, 30, "a"), []);
    assert.deepEqual(cardsNear(items, { x: 300, y: 50 }, 30), []);
  });
});

describe("keepApart", () => {
  it("leaves a point that is far enough alone", () => {
    assert.deepEqual(keepApart({ x: 100, y: 0 }, { x: 0, y: 0 }), { x: 100, y: 0 });
  });

  it("pushes a close point out along its direction", () => {
    assert.deepEqual(keepApart({ x: 0, y: 5 }, { x: 0, y: 0 }), { x: 0, y: MIN_LENGTH });
  });

  it("goes to the right when the points coincide", () => {
    assert.deepEqual(keepApart({ x: 7, y: 7 }, { x: 7, y: 7 }), { x: 7 + MIN_LENGTH, y: 7 });
  });
});

describe("segmentTouchesRect", () => {
  const rect = { left: 0, top: 0, right: 100, bottom: 100 };

  it("is true for a line that crosses, ends inside, or lies inside", () => {
    assert.equal(segmentTouchesRect({ x: -50, y: 50 }, { x: 150, y: 50 }, rect), true);
    assert.equal(segmentTouchesRect({ x: -50, y: 50 }, { x: 10, y: 50 }, rect), true);
    assert.equal(segmentTouchesRect({ x: 10, y: 10 }, { x: 20, y: 20 }, rect), true);
  });

  it("is false for a line that misses, even when its box overlaps", () => {
    assert.equal(segmentTouchesRect({ x: 200, y: 0 }, { x: 300, y: 50 }, rect), false);
    // The box of this diagonal covers the rectangle's corner, the line doesn't.
    assert.equal(segmentTouchesRect({ x: -50, y: 80 }, { x: 20, y: 150 }, rect), false);
  });

  it("handles flat lines", () => {
    assert.equal(segmentTouchesRect({ x: -10, y: 50 }, { x: 50, y: 50 }, rect), true);
    assert.equal(segmentTouchesRect({ x: -10, y: 150 }, { x: 50, y: 150 }, rect), false);
  });
});

describe("copied lines", () => {
  const line = (data) => ({ id: "l", type: "connector", x: 0, y: 0, w: 120, h: 0, z: 1, color: null, data });
  const parse = (items) => parsePayload(JSON.stringify(makePayload(items)))?.items ?? [];

  it("are accepted with free or attached ends", () => {
    const free = { start: { x: 0, y: 0 }, end: { x: 120, y: 0 } };
    const attached = { start: { x: 0, y: 0, item: "a", side: "right" }, end: { x: 120, y: 0 } };

    assert.equal(parse([line(free), line(attached)]).length, 2);
  });

  it("are dropped when an end is malformed", () => {
    const end = { x: 120, y: 0 };

    assert.equal(parse([line({ start: { x: 0 }, end })]).length, 0);
    assert.equal(parse([line({ start: { x: 0, y: 0, item: "a" }, end })]).length, 0);
    assert.equal(parse([line({ start: { x: 0, y: 0, item: "a", side: "middle" }, end })]).length, 0);
    assert.equal(parse([line({ start: { x: 0, y: 0 } })]).length, 0);
  });
});
