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
export const PALETTE = new Set(["grey", "red", "orange", "yellow", "green", "teal", "blue", "purple"]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOTE_SIZES = new Set(["s", "m", "l"]);

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

    return { url: cleanUrl(data.url), title: cleanLine(data.title, LIMITS.nameLength, "Title") };
  },

  section(data) {
    if (!isPlainObject(data)) {
      invalid("Invalid section.");
    }

    return { title: cleanLine(data.title, LIMITS.nameLength, "Title") };
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

  const { coordinate, minSize, maxSize } = LIMITS;
  const data = DATA_VALIDATORS[raw.type](raw.data);
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
