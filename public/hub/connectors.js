// Line connectors: a straight line with an arrowhead whose two ends are either
// free points or attached to the middle of a side of a card (a "hotspot").
//
// A connector item stores `data: { start, end }`. Each end is { x, y } and,
// when attached, also { item, side }. x and y always hold where the end is now
// (an attached end sits on its card's hotspot), so a line keeps its place when
// the card it was attached to goes away. The item's own x, y, w and h are the
// box around the two ends (zero wide or high for a straight horizontal or
// vertical line). These are pure helpers; board.js moves the lines.

export const SIDES = ["top", "right", "bottom", "left"];

// A new line, in world pixels (five grid cells).
export const DEFAULT_LENGTH = 120;
// Ends can't be dragged closer than this (one grid cell).
export const MIN_LENGTH = 24;

// The point at the middle of one side of a rectangle { x, y, w, h }.
export function hotspotPoint(rect, side) {
  switch (side) {
    case "top":
      return { x: rect.x + rect.w / 2, y: rect.y };
    case "bottom":
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h };
    case "left":
      return { x: rect.x, y: rect.y + rect.h / 2 };
    default:
      return { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
  }
}

// Cards a line can attach to: everything except other lines.
export const canAttachTo = (item) => Boolean(item) && item.type !== "connector";

// The card an end is attached to, or null when it is free (or the card is gone).
export function attachedCard(end, items) {
  const card = end.item ? items.get(end.item) : null;
  return canAttachTo(card) ? card : null;
}

// Where an end is now: on its card's hotspot, else its own point.
export function endPosition(end, items) {
  const card = attachedCard(end, items);
  return card ? hotspotPoint(card, end.side) : { x: end.x, y: end.y };
}

// The box around two points.
export function boundsOf(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x, b.x) - x, h: Math.max(a.y, b.y) - y };
}

const distanceBetween = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// The hotspot nearest a point, within `radius`, or null. Lines and the card
// `skipId` don't count, and neither does a hotspot closer than `minLength` to
// `awayFrom` (the line's other end), which would leave a line too short to see.
export function nearestHotspot(items, point, radius, { skipId = null, awayFrom = null, minLength = MIN_LENGTH } = {}) {
  let best = null;
  let bestDistance = radius;

  for (const card of items.values()) {
    if (!canAttachTo(card) || card.id === skipId) {
      continue;
    }

    if (
      point.x < card.x - radius || point.x > card.x + card.w + radius
      || point.y < card.y - radius || point.y > card.y + card.h + radius
    ) {
      continue;
    }

    for (const side of SIDES) {
      const spot = hotspotPoint(card, side);
      const gap = distanceBetween(spot, point);

      if (gap > bestDistance || (awayFrom && distanceBetween(spot, awayFrom) < minLength)) {
        continue;
      }

      // On a tie the card in front wins.
      if (!best || gap < bestDistance || card.z > best.z) {
        best = { item: card.id, side, x: spot.x, y: spot.y, z: card.z };
        bestDistance = gap;
      }
    }
  }

  return best && { item: best.item, side: best.side, x: best.x, y: best.y };
}

// Cards whose box, grown by `reach`, contains the point (their hotspots are
// shown while an end is dragged near them).
export function cardsNear(items, point, reach, skipId = null) {
  return [...items.values()].filter((card) => (
    canAttachTo(card)
    && card.id !== skipId
    && point.x >= card.x - reach && point.x <= card.x + card.w + reach
    && point.y >= card.y - reach && point.y <= card.y + card.h + reach
  ));
}

// `point` pushed out to at least `minLength` from `from`, in the direction it
// already lies in (to the right when the two coincide).
export function keepApart(point, from, minLength = MIN_LENGTH) {
  const gap = distanceBetween(point, from);

  if (gap >= minLength) {
    return point;
  }

  const dx = gap ? (point.x - from.x) / gap : 1;
  const dy = gap ? (point.y - from.y) / gap : 0;
  return { x: from.x + dx * minLength, y: from.y + dy * minLength };
}

// True when the segment a-b crosses or lies inside the rectangle { left, top,
// right, bottom } (used by the selection marquee).
export function segmentTouchesRect(a, b, rect) {
  // Liang-Barsky clipping.
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges = [
    [-dx, a.x - rect.left],
    [dx, rect.right - a.x],
    [-dy, a.y - rect.top],
    [dy, rect.bottom - a.y]
  ];

  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) {
        return false;
      }
    } else {
      const t = q / p;

      if (p < 0) {
        t0 = Math.max(t0, t);
      } else {
        t1 = Math.min(t1, t);
      }

      if (t0 > t1) {
        return false;
      }
    }
  }

  return true;
}
