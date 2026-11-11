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

// Right-angle ("elbow") lines: data.shape is "elbow" (a straight line has no
// shape). Each end has a direction, the way a line leaves it: an attached end
// leaves its card at right angles to the side it is on; a free end keeps the
// direction it last had. The route follows from the two directions alone, so
// there is nothing to adjust:
//   - at right angles to each other: one turn (an L) with the corner fixed at
//     the end where the first segment meets the second end's row or column;
//   - facing each other (opposite): two turns (a Z), the middle segment halfway;
//   - the same way (a C): two turns, the middle segment one grid cell beyond
//     the farther end.
export const DIRECTIONS = ["up", "right", "down", "left"];
export const SIDE_DIRECTION = { top: "up", right: "right", bottom: "down", left: "left" };
const OPPOSITE = { up: "down", down: "up", left: "right", right: "left" };
const isHorizontal = (direction) => direction === "left" || direction === "right";

// A new line, in world pixels (five grid cells long; a right-angle line is also
// two cells tall).
export const DEFAULT_LENGTH = 120;
export const DEFAULT_RISE = 48;
// Ends can't be dragged closer than this (one grid cell).
export const MIN_LENGTH = 24;
// How far a C-shaped line goes beyond its farther end (one grid cell).
export const BEND_MARGIN = 24;

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
  return boundsOfPoints([a, b]);
}

// The box around any number of points.
export function boundsOfPoints(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// Drops points that add no corner: repeats, and points on a straight run.
function withoutRedundantPoints(points) {
  const kept = [points[0]];

  for (let i = 1; i < points.length; i++) {
    const previous = kept[kept.length - 1];

    if (points[i].x === previous.x && points[i].y === previous.y) {
      continue;
    }

    const next = points[i + 1];

    if (next) {
      const cross = (points[i].x - previous.x) * (next.y - points[i].y)
        - (points[i].y - previous.y) * (next.x - points[i].x);

      if (cross === 0) {
        continue;
      }
    }

    kept.push(points[i]);
  }

  return kept;
}

// The corners of a right-angle line from `a` (leaving in `aDirection`) to `b`
// (leaving in `bDirection`, i.e. arriving the other way). Always starts at a
// and ends at b; ends in line with each other make a straight run.
export function elbowRoute(a, aDirection, b, bDirection) {
  const points = [{ x: a.x, y: a.y }];

  if (isHorizontal(aDirection) !== isHorizontal(bDirection)) {
    // L: along a's direction to b's row or column, then straight to b.
    points.push(isHorizontal(aDirection) ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
  } else if (aDirection === bDirection) {
    // C: out past the farther end, across, and back.
    if (isHorizontal(aDirection)) {
      const x = aDirection === "right" ? Math.max(a.x, b.x) + BEND_MARGIN : Math.min(a.x, b.x) - BEND_MARGIN;
      points.push({ x, y: a.y }, { x, y: b.y });
    } else {
      const y = aDirection === "down" ? Math.max(a.y, b.y) + BEND_MARGIN : Math.min(a.y, b.y) - BEND_MARGIN;
      points.push({ x: a.x, y }, { x: b.x, y });
    }
  } else if (isHorizontal(aDirection)) {
    // Z: halfway between the ends.
    const x = (a.x + b.x) / 2;
    points.push({ x, y: a.y }, { x, y: b.y });
  } else {
    const y = (a.y + b.y) / 2;
    points.push({ x: a.x, y }, { x: b.x, y });
  }

  points.push({ x: b.x, y: b.y });
  return withoutRedundantPoints(points);
}

// The points a line is drawn through: its two ends, or the corners between
// them for a right-angle line.
export function linePoints(data) {
  const { start, end } = data;

  if (data.shape !== "elbow") {
    return [{ x: start.x, y: start.y }, { x: end.x, y: end.y }];
  }

  return elbowRoute(start, start.dir ?? "right", end, end.dir ?? "left");
}

// Sets the direction of every end of a right-angle line: an attached end leaves
// at right angles to its card's side; a free end keeps its direction, or gets one
// if it has none yet (a new line, or one just switched from straight): at right
// angles to the other end's direction when that has one (an L), else facing it
// along the longer side (a Z).
export function fillDirections(data) {
  const { start, end } = data;

  for (const line of [start, end]) {
    if (line.item) {
      line.dir = SIDE_DIRECTION[line.side];
    }
  }

  if (start.dir && end.dir) {
    return;
  }

  if (start.dir || end.dir) {
    const [known, open] = start.dir ? [start, end] : [end, start];

    open.dir = isHorizontal(known.dir)
      ? (known.y > open.y ? "down" : "up")
      : (known.x > open.x ? "right" : "left");
    return;
  }

  if (Math.abs(end.x - start.x) >= Math.abs(end.y - start.y)) {
    start.dir = end.x >= start.x ? "right" : "left";
  } else {
    start.dir = end.y >= start.y ? "down" : "up";
  }

  end.dir = OPPOSITE[start.dir];
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
