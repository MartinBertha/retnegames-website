// Card elements. User text reaches the DOM only as text nodes or input
// values, and URLs become links only when they parse as http(s).

import { fileUrl } from "./api.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const URL_PATTERN = /https?:\/\/[^\s<>"]+/gi;
const TRAILING_PUNCTUATION = ".,;:!?'";
const ROW_MOVE_MS = 180;

export const COLORS = ["grey", "red", "orange", "yellow", "green", "teal", "blue", "purple"];

export const CARD_TYPES = {
  note: { w: 240, h: 120, minW: 80, minH: 48 },
  checklist: { w: 260, h: 140, minW: 160, minH: 72 },
  image: { w: 320, h: 240, minW: 60, minH: 40 },
  link: { w: 260, h: 84, minW: 160, minH: 64 },
  section: { w: 520, h: 360, minW: 160, minH: 100 },
  folder: { w: 160, h: 150, minW: 110, minH: 110 }
};

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

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

export function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);

  if (className) {
    node.className = className;
  }

  if (text !== undefined) {
    node.textContent = text;
  }

  return node;
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

function externalLink(className, href, text) {
  const link = el("a", className, text);
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.draggable = false;
  return link;
}

function appendLinkedText(parent, text) {
  let index = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const label = trimUrl(match[0]);
    const href = httpUrl(label);

    if (!href) {
      continue;
    }

    parent.append(text.slice(index, match.index), externalLink("", href, label));
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

const STRUCTURE = {
  note: () => [el("div", "note-title"), el("div", "note-text")],
  checklist: () => {
    const add = el("button", "entry-add card-control", "+ Add item");
    add.type = "button";
    return [el("div", "checklist-head"), el("ul", "checklist-entries"), add];
  },
  image: () => {
    const image = el("img", "image-content");
    image.draggable = false;
    image.decoding = "async";
    image.addEventListener("error", () => image.closest(".card")?.classList.add("is-broken"));
    return [image, el("div", "image-caption")];
  },
  link: () => [el("a", "link-title"), el("div", "link-host")],
  section: () => [el("div", "section-title")],
  folder: () => [folderIcon(), el("div", "folder-name")]
};

// What a screen reader announces for a focused card.
function describe(item) {
  const { data } = item;

  switch (item.type) {
    case "note": {
      const text = data.text.trim().slice(0, 80);
      return `Note: ${[data.title, text].filter(Boolean).join(". ") || "empty"}`;
    }
    case "checklist": {
      const done = data.entries.filter((entry) => entry.done).length;
      return `Checklist${data.title ? ` ${data.title}` : ""}: ${done} of ${data.entries.length} done`;
    }
    case "image":
      return `Image${data.caption ? `: ${data.caption}` : ""}`;
    case "link":
      return `Link: ${data.title || hostname(data.url)}`;
    case "section":
      return `Section: ${data.title || "untitled"}`;
    case "folder":
      return `Folder: ${data.name}. Press Enter to open.`;
    default:
      return "Card";
  }
}

// Cards take keyboard focus: Tab moves between them, Enter edits or opens.
export function createCardElement(item) {
  const card = el("div", `card card-${item.type}`);
  card.dataset.id = item.id;
  card.tabIndex = 0;
  card.setAttribute("role", "group");
  card.setAttribute("aria-roledescription", "card");
  card.append(...STRUCTURE[item.type]());

  const handle = el("div", "resize-handle");
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

// Rows slide from their old place to the new one (checklist reordering).
function animateRows(list, oldTops) {
  if (reducedMotion.matches || !oldTops.size) {
    return;
  }

  for (const row of list.children) {
    const delta = (oldTops.get(row.dataset.entryId) ?? row.offsetTop) - row.offsetTop;

    if (delta) {
      row.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
        { duration: ROW_MOVE_MS, easing: "ease-out" }
      );
    }
  }
}

function entryEditor(className, value, label, maxLength) {
  const input = el("input", `card-editor ${className}`);
  input.type = "text";
  input.value = value;
  input.maxLength = maxLength;
  input.enterKeyHint = "next";
  input.setAttribute("aria-label", label);
  return input;
}

// Static, or with inputs for the title and every entry while editing.
export function renderChecklist(card, item, { editing = false } = {}) {
  const { title, entries } = item.data;
  const head = card.querySelector(".checklist-head");
  const list = card.querySelector(".checklist-entries");
  const oldTops = new Map([...list.children].map((row) => [row.dataset.entryId, row.offsetTop]));

  if (editing) {
    const input = entryEditor("checklist-title-editor", title, "Checklist title", 100);
    input.placeholder = "Title";
    head.replaceChildren(input);
    head.hidden = false;
  } else {
    head.textContent = title;
    head.hidden = !title;
  }

  list.replaceChildren(...entries.map((entry) => {
    const row = el("li", entry.done ? "entry is-done" : "entry");
    row.dataset.entryId = entry.id;

    if (!editing && !entry.done) {
      const handle = el("span", "entry-handle");
      handle.setAttribute("aria-hidden", "true");
      row.append(handle);
    }

    const check = el("button", "entry-check card-control");
    check.type = "button";
    check.setAttribute("role", "checkbox");
    check.setAttribute("aria-checked", String(entry.done));
    check.setAttribute("aria-label", entry.text || "Item");
    row.append(check);

    if (editing) {
      const input = entryEditor("entry-editor", entry.text, "Checklist item", 500);
      input.dataset.entryId = entry.id;
      row.append(input);
    } else {
      row.append(el("span", "entry-text", entry.text));
    }

    return row;
  }));

  animateRows(list, oldTops);
}

const RENDERERS = {
  note(card, item) {
    card.classList.toggle("note-s", item.data.size === "s");
    card.classList.toggle("note-l", item.data.size === "l");

    const title = card.querySelector(".note-title");
    title.textContent = item.data.title ?? "";
    title.hidden = !item.data.title;

    const text = card.querySelector(".note-text");
    text.replaceChildren();
    appendLinkedText(text, item.data.text);
  },

  checklist(card, item) {
    renderChecklist(card, item);
  },

  image(card, item) {
    const image = card.querySelector(".image-content");
    const caption = card.querySelector(".image-caption");
    const src = fileUrl(item.data.fileId);

    if (image.getAttribute("src") !== src) {
      card.classList.remove("is-broken");
      image.src = src;
    }

    image.alt = item.data.caption || "Image";
    caption.textContent = item.data.caption;
    caption.hidden = !item.data.caption;
  },

  link(card, item) {
    const title = card.querySelector(".link-title");
    const host = hostname(item.data.url);
    const href = httpUrl(item.data.url);

    if (href) {
      title.href = href;
      title.target = "_blank";
      title.rel = "noopener noreferrer";
      title.draggable = false;
    } else {
      title.removeAttribute("href");
    }

    title.textContent = item.data.title || host || item.data.url;
    card.querySelector(".link-host").textContent = host;
  },

  section(card, item) {
    const title = card.querySelector(".section-title");
    title.textContent = item.data.title || "Section";
    title.classList.toggle("is-placeholder", !item.data.title);
  },

  folder(card, item) {
    const name = card.querySelector(".folder-name");
    name.textContent = item.data.name;
    name.title = item.data.name;
  }
};

export function updateCardElement(card, item) {
  positionCard(card, item);

  if (COLORS.includes(item.color)) {
    card.dataset.color = item.color;
  } else {
    delete card.dataset.color;
  }

  const key = JSON.stringify(item.data);

  if (rendered.get(card) !== key) {
    RENDERERS[item.type](card, item);
    card.setAttribute("aria-label", describe(item));
    rendered.set(card, key);
  }
}

// Forces the next updateCardElement to re-render (after an editor changed the DOM).
export function invalidateCard(card) {
  rendered.delete(card);
}
