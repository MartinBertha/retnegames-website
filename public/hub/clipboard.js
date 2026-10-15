// Copied cards. Ctrl/Cmd+C, X and V use the system clipboard (so whatever was
// copied last wins, and cards paste into other hub tabs); the card menu's
// Paste uses the last cards copied on this device, kept in localStorage.

export const CARDS_MIME = "application/x-retne-hub-cards";

const STORAGE_KEY = "hub-clipboard";
const FORMAT = "retne-hub-cards";

export function makePayload(items) {
  return { format: FORMAT, version: 1, copiedAt: Date.now(), items };
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value) => typeof value === "string";

// The shape the board needs to draw a card; the server checks the rest.
const DATA_SHAPES = {
  note: (data) => isString(data.text),
  checklist: (data) => Array.isArray(data.entries) && data.entries.every((entry) => isObject(entry) && isString(entry.text)),
  image: (data) => isString(data.fileId),
  link: (data) => isString(data.url),
  section: (data) => isString(data.title),
  folder: (data) => isString(data.name) && isString(data.childBoardId)
};

function isCard(item) {
  return isObject(item)
    && Object.hasOwn(DATA_SHAPES, item.type)
    && ["x", "y", "w", "h", "z"].every((key) => Number.isFinite(item[key]))
    && (item.color === null || isString(item.color))
    && isObject(item.data)
    && DATA_SHAPES[item.type](item.data);
}

// Copied cards from text, or null. Cards that don't look right are dropped.
export function parsePayload(text) {
  try {
    const payload = JSON.parse(text);

    if (payload?.format !== FORMAT || !Array.isArray(payload.items)) {
      return null;
    }

    const items = payload.items.filter(isCard).slice(0, 2_000);
    return items.length ? { ...payload, items } : null;
  } catch {
    return null;
  }
}

export function storePayload(payload) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage blocked or full: keyboard paste still works.
  }
}

export function storedPayload() {
  try {
    return parsePayload(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

// Readable text for pasting into other apps.
export function payloadText(payload) {
  return payload.items.map((item) => {
    const { data } = item;

    switch (item.type) {
      case "note":
        return [data.title, data.text].filter(Boolean).join("\n");
      case "checklist":
        return [data.title, ...data.entries.map((entry) => `- [${entry.done ? "x" : " "}] ${entry.text}`)]
          .filter(Boolean).join("\n");
      case "link":
        return [data.title, data.url].filter(Boolean).join("\n");
      case "image":
        return data.caption;
      case "section":
        return data.title;
      case "folder":
        return data.name;
      default:
        return "";
    }
  }).filter(Boolean).join("\n\n");
}
