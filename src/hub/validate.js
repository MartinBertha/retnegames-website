// Input validation for the hub API (docs/hub-spec.md, section 4 limits).
// Anything outside the limits is rejected with 400.

import { HttpError } from "./http.js";

export const LIMITS = {
  nameLength: 100,
  noteLength: 20_000,
  dataBytes: 64 * 1024,
  coordinate: 1_000_000,
  minSize: 40,
  maxSize: 10_000,
  zIndex: 1_000_000_000
};

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

function boundedNumber(value, min, max, message) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    invalid(message);
  }

  return value;
}

// Normalised data per card type; unknown keys are dropped.
const DATA_VALIDATORS = {
  note(data) {
    if (!isPlainObject(data) || !NOTE_SIZES.has(data.size)) {
      invalid("Invalid note.");
    }

    return { text: cleanText(data.text, LIMITS.noteLength, "Note text"), size: data.size };
  },

  folder(data) {
    if (!isPlainObject(data) || !isUuid(data.childBoardId)) {
      invalid("Invalid folder.");
    }

    return { name: cleanName(data.name), childBoardId: data.childBoardId };
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

  // The colour palette arrives with milestone 3; until then cards have none.
  if (raw.color !== null && raw.color !== undefined) {
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
    color: null,
    data,
    dataJson
  };
}
