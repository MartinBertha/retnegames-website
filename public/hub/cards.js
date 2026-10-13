// Card elements. User text reaches the DOM only as text nodes, and URLs in
// notes become links only when they parse as http(s).

const SVG_NS = "http://www.w3.org/2000/svg";
const URL_PATTERN = /https?:\/\/[^\s<>"]+/gi;
const TRAILING_PUNCTUATION = ".,;:!?'";

export const CARD_TYPES = {
  note: { w: 240, h: 120, minW: 80, minH: 48 },
  folder: { w: 160, h: 150, minW: 110, minH: 110 }
};

// What each element currently shows, to skip needless re-renders.
const rendered = new WeakMap();

export function httpUrl(text) {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

// "See https://example.com/a_(b)." links "https://example.com/a_(b)".
function trimUrl(raw) {
  let url = raw;

  for (;;) {
    const last = url.at(-1);
    const opens = url.split("(").length;
    const closes = url.split(")").length;

    if (TRAILING_PUNCTUATION.includes(last) || (last === ")" && closes > opens)) {
      url = url.slice(0, -1);
    } else {
      return url;
    }
  }
}

function appendLinkedText(parent, text) {
  let index = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const label = trimUrl(match[0]);
    const href = httpUrl(label);

    if (!href) {
      continue;
    }

    parent.append(text.slice(index, match.index));

    const link = document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = label;
    parent.append(link);

    index = match.index + label.length;
  }

  parent.append(text.slice(index));
}

function folderIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 64 52");
  svg.setAttribute("class", "folder-icon");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M2 8a5 5 0 0 1 5-5h15l6 6h29a5 5 0 0 1 5 5v31a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5z");
  svg.append(path);

  return svg;
}

export function createCardElement(item) {
  const card = document.createElement("div");
  card.className = `card card-${item.type}`;
  card.dataset.id = item.id;

  if (item.type === "note") {
    const text = document.createElement("div");
    text.className = "note-text";
    card.append(text);
  } else if (item.type === "folder") {
    const name = document.createElement("div");
    name.className = "folder-name";
    card.append(folderIcon(), name);
  }

  const handle = document.createElement("div");
  handle.className = "resize-handle";
  handle.setAttribute("aria-hidden", "true");
  card.append(handle);

  updateCardElement(card, item);
  return card;
}

export function positionCard(card, item) {
  card.style.left = `${item.x}px`;
  card.style.top = `${item.y}px`;
  card.style.width = `${item.w}px`;
  card.style.height = `${item.h}px`;
  card.style.zIndex = String(item.z);
}

export function updateCardElement(card, item) {
  positionCard(card, item);

  const previous = rendered.get(card);

  if (item.type === "note") {
    card.classList.toggle("note-s", item.data.size === "s");
    card.classList.toggle("note-l", item.data.size === "l");

    if (previous?.text !== item.data.text) {
      const text = card.querySelector(".note-text");
      text.replaceChildren();
      appendLinkedText(text, item.data.text);
      rendered.set(card, { text: item.data.text });
    }
  } else if (item.type === "folder" && previous?.name !== item.data.name) {
    const name = card.querySelector(".folder-name");
    name.textContent = item.data.name;
    name.title = item.data.name;
    rendered.set(card, { name: item.data.name });
  }
}
