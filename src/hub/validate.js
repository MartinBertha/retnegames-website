// Input validation for the hub API (docs/hub-spec.md, section 4 limits).
// Anything outside the limits is rejected with 400.

import { HttpError } from "./http.js";

export const LIMITS = {
  nameLength: 100,
  noteLength: 20_000,
  entryLength: 500,
  entries: 200,
  captionLength: 500,
  urlLength: 2_048,
  dataBytes: 64 * 1024,
  coordinate: 1_000_000,
  minSize: 40,
  maxSize: 10_000,
  zIndex: 1_000_000_000
};

// Card colours (palette keys); null is the default card colour.
// The first eight are the original palette; null (the default) makes 16.
export const PALETTE = new Set([
  "grey", "slate", "brown", "sand", "red", "pink", "orange", "yellow",
  "lime", "green", "teal", "cyan", "blue", "indigo", "purple"
]);

// What each object type lets you style (public/hub/styles.js has the same
// table, and a test keeps them equal): its pieces of text, and for each the
// properties that can be set (`sizes` narrows the text sizes, default s to
// xl); and its `extras`, each "bool", "color" or a list of allowed values.
export const STYLE_RULES = {
  note: {
    alpha: true,
    sets: {
      title: { props: ["color", "font", "size", "bold", "italic", "align"] },
      body: { props: ["color", "font", "size", "bold", "italic", "list", "align", "valign"] }
    }
  },
  checklist: {
    alpha: true,
    sets: {
      title: { props: ["color", "font", "size", "bold", "italic"] },
      items: { props: ["color", "font", "size", "bold", "italic", "strike"] }
    }
  },
  image: {
    alpha: true,
    sets: { caption: { props: ["size", "align"] } },
    extras: {
      flipX: "bool",
      flipY: "bool",
      border: ["none", "thin", "thick"],
      borderColor: "color",
      corners: ["square", "rounded"]
    }
  },
  link: {
    alpha: true,
    sets: { text: { props: ["color", "font", "size", "bold", "italic", "align", "valign", "address"] } }
  },
  section: {
    alpha: true,
    sets: { title: { props: ["color", "font", "size", "align"] } },
    extras: { border: ["dashed", "solid", "none"] }
  },
  folder: { alpha: false, sets: { label: { props: ["color", "size", "bold"], sizes: ["s", "m", "l"] } } },
  connector: {
    alpha: true,
    sets: {},
    extras: {
      thickness: ["thin", "medium", "thick"],
      dash: ["solid", "dashed", "dotted"],
      arrow: ["none", "end", "start", "both"]
    }
  }
};

const STYLE_ALPHAS = new Set([100, 75, 50, 25]);
// On/off properties of a piece of text: bold, italic, struck-through ticked
// checklist items, and a link's address line shown.
const BOOLEAN_PROPS = new Set(["bold", "italic", "strike", "address"]);
const STYLE_VALUES = {
  font: new Set(["sans", "serif", "mono"]),
  size: ["s", "m", "l", "xl"],
  align: new Set(["left", "center", "right"]),
  valign: new Set(["top", "middle", "bottom"]),
  list: new Set(["none", "bullet", "number", "alpha"])
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOTE_SIZES = new Set(["s", "m", "l", "xl"]);
// The sides of a card a line can attach to (the middle of each).
const LINE_SIDES = new Set(["top", "right", "bottom", "left"]);
// The way a right-angle line leaves one of its ends.
const LINE_DIRECTIONS = new Set(["up", "right", "down", "left"]);

function invalid(message) {
  throw new HttpError(400, message);
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

// Names are single-line plain text: whitespace and control characters collapse
// to single spaces.
export function cleanName(value) {
  if (typeof value !== "string") {
    invalid("Name must be text.");
  }

  const name = value.toWellFormed().replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();

  if (!name || name.length > LIMITS.nameLength) {
    invalid(`Name must be 1 to ${LIMITS.nameLength} characters.`);
  }

  return name;
}

// Multi-line plain text: keeps tabs and line breaks, drops other control characters.
function cleanText(value, maxLength, label) {
  if (typeof value !== "string") {
    invalid(`${label} must be text.`);
  }

  const text = value
    .toWellFormed()
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

  if (text.length > maxLength) {
    invalid(`${label} can be at most ${maxLength.toLocaleString("en")} characters.`);
  }

  return text;
}

// Single-line text that may be empty (titles, captions, checklist entries).
function cleanLine(value, maxLength, label) {
  if (value === undefined) {
    return "";
  }

  if (typeof value !== "string") {
    invalid(`${label} must be text.`);
  }

  const text = value.toWellFormed().replace(/[\u0000-\u001f\u007f]+/g, " ").trim();

  if (text.length > maxLength) {
    invalid(`${label} can be at most ${maxLength.toLocaleString("en")} characters.`);
  }

  return text;
}

// http and https only; returns the normalised URL.
export function cleanUrl(value) {
  if (typeof value !== "string" || value.length > LIMITS.urlLength) {
    invalid("Invalid link.");
  }

  let url;

  try {
    url = new URL(value.trim());
  } catch {
    invalid("Invalid link.");
  }

  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.href.length > LIMITS.urlLength) {
    invalid("Links must start with http:// or https://.");
  }

  return url.href;
}

// Checklist ordering rule (docs/hub-spec.md, section 4): unticked entries
// first, ticked entries after, each group keeping its order.
export function orderEntries(entries) {
  return [...entries.filter((entry) => !entry.done), ...entries.filter((entry) => entry.done)];
}

function boundedNumber(value, min, max, message) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    invalid(message);
  }

  return value;
}

// One end of a line: its position, plus the card (and side) it is attached to.
// The position is kept for attached ends too: it is where the end sits now,
// and where it stays if the card goes away.
function cleanLineEnd(end) {
  if (!isPlainObject(end)) {
    invalid("Invalid line.");
  }

  const point = {
    x: boundedNumber(end.x, -LIMITS.coordinate, LIMITS.coordinate, "Invalid line position."),
    y: boundedNumber(end.y, -LIMITS.coordinate, LIMITS.coordinate, "Invalid line position.")
  };

  // Right-angle lines keep the direction each end leaves in.
  if (end.dir != null) {
    if (!LINE_DIRECTIONS.has(end.dir)) {
      invalid("Invalid line direction.");
    }

    point.dir = end.dir;
  }

  if (end.item == null && end.side == null) {
    return point;
  }

  if (!isUuid(end.item) || !LINE_SIDES.has(end.side)) {
    invalid("Invalid line attachment.");
  }

  return { ...point, item: end.item, side: end.side };
}

// One piece of text's style: only the properties the object offers are kept
// (others are dropped), and a value out of range is rejected.
function cleanTextStyle(style, rules) {
  if (!isPlainObject(style)) {
    invalid("Invalid style.");
  }

  const clean = {};

  for (const prop of rules.props) {
    const value = style[prop];

    if (value === undefined) {
      continue;
    }

    const allowed = prop === "color" ? PALETTE.has(value)
      : BOOLEAN_PROPS.has(prop) ? typeof value === "boolean"
        : prop === "size" ? (rules.sizes ?? STYLE_VALUES.size).includes(value)
          : STYLE_VALUES[prop].has(value);

    if (!allowed) {
      invalid("Invalid style.");
    }

    clean[prop] = value;
  }

  return clean;
}

// data.style for an object of this type: { alpha?, <text>: {...} }, or
// undefined when it holds nothing (100% opacity is the default).
function cleanStyle(type, style) {
  if (style === undefined || style === null) {
    return undefined;
  }

  if (!isPlainObject(style)) {
    invalid("Invalid style.");
  }

  const rules = STYLE_RULES[type];
  const clean = {};

  if (style.alpha !== undefined) {
    if (!rules.alpha || !STYLE_ALPHAS.has(style.alpha)) {
      invalid("Invalid opacity.");
    }

    if (style.alpha !== 100) {
      clean.alpha = style.alpha;
    }
  }

  for (const [key, setRules] of Object.entries(rules.sets)) {
    if (style[key] !== undefined) {
      const text = cleanTextStyle(style[key], setRules);

      if (Object.keys(text).length) {
        clean[key] = text;
      }
    }
  }

  for (const [key, allowed] of Object.entries(rules.extras ?? {})) {
    const value = style[key];

    if (value === undefined) {
      continue;
    }

    const valid = allowed === "bool" ? typeof value === "boolean"
      : allowed === "color" ? PALETTE.has(value)
        : allowed.includes(value);

    if (!valid) {
      invalid("Invalid style.");
    }

    clean[key] = value;
  }

  return Object.keys(clean).length ? clean : undefined;
}

// Normalised data per card type; unknown keys are dropped.
const DATA_VALIDATORS = {
  // The title is optional (notes saved before it existed have none).
  note(data) {
    if (!isPlainObject(data) || !NOTE_SIZES.has(data.size)) {
      invalid("Invalid note.");
    }

    return {
      title: cleanLine(data.title, LIMITS.nameLength, "Title"),
      text: cleanText(data.text, LIMITS.noteLength, "Note text"),
      size: data.size
    };
  },

  folder(data) {
    if (!isPlainObject(data) || !isUuid(data.childBoardId)) {
      invalid("Invalid folder.");
    }

    return { name: cleanName(data.name), childBoardId: data.childBoardId };
  },

  checklist(data) {
    if (!isPlainObject(data) || !Array.isArray(data.entries)) {
      invalid("Invalid checklist.");
    }

    if (data.entries.length > LIMITS.entries) {
      invalid(`A checklist can have at most ${LIMITS.entries} items.`);
    }

    const seen = new Set();
    const entries = data.entries.map((entry) => {
      if (!isPlainObject(entry) || !isUuid(entry.id) || typeof entry.done !== "boolean" || seen.has(entry.id)) {
        invalid("Invalid checklist item.");
      }

      seen.add(entry.id);
      return { id: entry.id, text: cleanLine(entry.text, LIMITS.entryLength, "Checklist item"), done: entry.done };
    });

    return { title: cleanLine(data.title, LIMITS.nameLength, "Title"), entries: orderEntries(entries) };
  },

  image(data) {
    if (!isPlainObject(data) || !isUuid(data.fileId)) {
      invalid("Invalid image.");
    }

    return { fileId: data.fileId, caption: cleanLine(data.caption, LIMITS.captionLength, "Caption") };
  },

  link(data) {
    if (!isPlainObject(data)) {
      invalid("Invalid link.");
    }

    // An empty address is a link card that hasn't been filled in yet.
    const url = typeof data.url === "string" && !data.url.trim() ? "" : cleanUrl(data.url);
    return { url, title: cleanLine(data.title, LIMITS.nameLength, "Title") };
  },

  section(data) {
    if (!isPlainObject(data)) {
      invalid("Invalid section.");
    }

    return { title: cleanLine(data.title, LIMITS.nameLength, "Title") };
  },

  // Two ends, each a point and, when attached, the card and side it follows.
  connector(data) {
    if (!isPlainObject(data)) {
      invalid("Invalid line.");
    }

    const start = cleanLineEnd(data.start);
    const end = cleanLineEnd(data.end);

    // A line between two sides of one card would only cut across it.
    if (start.item && start.item === end.item) {
      invalid("A line can't join a card to itself.");
    }

    // Straight is the default and isn't stored.
    if (data.shape != null && data.shape !== "straight" && data.shape !== "elbow") {
      invalid("Invalid line type.");
    }

    return data.shape === "elbow" ? { shape: "elbow", start, end } : { start, end };
  }
};

// Returns the normalised item plus its data serialised for storage (dataJson).
export function validateItem(raw) {
  if (!isPlainObject(raw) || !isUuid(raw.id)) {
    invalid("Invalid card.");
  }

  if (!Object.hasOwn(DATA_VALIDATORS, raw.type)) {
    invalid("Unsupported card type.");
  }

  const color = raw.color ?? null;

  if (color !== null && !PALETTE.has(color)) {
    invalid("Invalid colour.");
  }

  if (!Number.isSafeInteger(raw.z) || Math.abs(raw.z) > LIMITS.zIndex) {
    invalid("Invalid card order.");
  }

  const { coordinate } = LIMITS;
  // A line's box spans its two ends, so it can be flat (zero height or width)
  // or as long as the coordinate range; cards have a minimum and a maximum.
  const { min: minSize, max: maxSize } = raw.type === "connector"
    ? { min: 0, max: coordinate * 2 }
    : { min: LIMITS.minSize, max: LIMITS.maxSize };
  const data = DATA_VALIDATORS[raw.type](raw.data);
  const style = cleanStyle(raw.type, raw.data.style);

  if (style) {
    data.style = style;
  }

  const dataJson = JSON.stringify(data);

  if (new TextEncoder().encode(dataJson).length > LIMITS.dataBytes) {
    invalid("Card content is too large.");
  }

  return {
    id: raw.id,
    type: raw.type,
    x: boundedNumber(raw.x, -coordinate, coordinate, "Invalid card position."),
    y: boundedNumber(raw.y, -coordinate, coordinate, "Invalid card position."),
    w: boundedNumber(raw.w, minSize, maxSize, "Invalid card size."),
    h: boundedNumber(raw.h, minSize, maxSize, "Invalid card size."),
    z: raw.z,
    color,
    data,
    dataJson
  };
}
