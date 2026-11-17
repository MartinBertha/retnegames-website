// "Go to" (docs/hub-spec.md, section 6 "Search and Go to"): Ctrl/Cmd+K, "/",
// or the search button. With nothing typed it lists the recently opened
// boards and every board as a tree; typing searches board names and the
// words on every card (search.js). Enter or a click opens the board, or the
// card's board with the card centred. A native modal <dialog>; results are
// built with textContent, matches marked with <mark>.

import { api, fileUrl } from "./api.js";
import { el } from "./dialog.js";
import { typeName } from "./labels.js";
import { boardTree, matchRanges, prepareIndex, queryWords, search, segments, snippet } from "./search.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const RECENT_KEY = "hub-recent-boards";
const MAX_RECENT = 8;
const SHOWN_RECENT = 5;
const FLUSH_WAIT_MS = 1500;

let index = null;
let loading = null;
const listeners = new Set();
let counter = 0;

// ---- The index, shared with the names shown for card links ------------------

export function currentIndex() {
  return index;
}

// Called with the new index each time it loads.
export function onIndexLoaded(listener) {
  listeners.add(listener);
}

export function refreshIndex() {
  loading ??= api.searchIndex()
    .then((data) => {
      index = prepareIndex(data);

      for (const listener of listeners) {
        listener(index);
      }

      return index;
    })
    .finally(() => {
      loading = null;
    });

  return loading;
}

// ---- Recently opened boards (this device only) ------------------------------

export function recordRecentBoard(id) {
  try {
    const recent = readRecent().filter((other) => other !== id);
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recent].slice(0, MAX_RECENT)));
  } catch {
    // Storage blocked: no recent boards.
  }
}

function readRecent() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

// ---- The dialog -------------------------------------------------------------

function icon(paths) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");

  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }

  return svg;
}

const SEARCH_ICON = ["M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z", "M15.5 15.5L20 20"];
const BOARD_ICON = ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"];
const CARD_ICON = ["M5 4h14v16H5z", "M8 9h8M8 13h8M8 17h5"];

// Text with the matched words marked.
function marked(className, text, words) {
  const node = el("span", className);

  for (const piece of segments(text, words.length ? matchRanges(text, words) : [])) {
    node.append(piece.mark ? el("mark", "", piece.text) : piece.text);
  }

  return node;
}

function markedSnippet(className, { text, ranges }) {
  const node = el("span", className);

  for (const piece of segments(text, ranges)) {
    node.append(piece.mark ? el("mark", "", piece.text) : piece.text);
  }

  return node;
}

export class Finder {
  // getBoardId(): the open board. flush(): saves pending changes.
  // onOpenBoard(id), onOpenCard(boardId, cardId).
  constructor({ getBoardId, flush, onOpenBoard, onOpenCard }) {
    this.getBoardId = getBoardId;
    this.flush = flush;
    this.onOpenBoard = onOpenBoard;
    this.onOpenCard = onOpenCard;
    this.dialog = null;
  }

  get isOpen() {
    return Boolean(this.dialog);
  }

  open() {
    if (this.dialog) {
      this.input.focus();
      this.input.select();
      return;
    }

    const id = `finder-${++counter}`;
    const dialog = el("dialog", "dialog finder");
    const head = el("div", "finder-head");
    const input = el("input", "finder-input");
    const list = el("ul", "finder-results");
    const status = el("p", "finder-status");
    const foot = el("p", "finder-foot", "↑ ↓ to choose · Enter to open · Esc to close");

    dialog.setAttribute("aria-label", "Search and go to");
    input.type = "search";
    input.placeholder = "Search boards and cards…";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.enterKeyHint = "go";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-label", "Search boards and cards");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", `${id}-list`);
    input.setAttribute("aria-autocomplete", "list");
    list.id = `${id}-list`;
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Results");
    status.setAttribute("role", "status");

    head.append(icon(SEARCH_ICON), input);
    dialog.append(head, status, list, foot);
    document.body.append(dialog);

    this.dialog = dialog;
    this.input = input;
    this.list = list;
    this.status = status;
    this.options = [];
    this.active = -1;
    this.idPrefix = id;

    input.addEventListener("input", () => this.render());
    input.addEventListener("keydown", (event) => this.onKeyDown(event));
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        dialog.close();
      }
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      this.dialog = null;
    });

    dialog.showModal();
    input.focus();
    this.render();
    this.load();
  }

  close() {
    this.dialog?.close();
  }

  // Shows what's known at once; fetches the index again (after saving what's
  // pending, so the results include it) and redraws.
  async load() {
    if (!index) {
      this.status.textContent = "Loading…";
    }

    try {
      await Promise.race([this.flush(), new Promise((resolve) => setTimeout(resolve, FLUSH_WAIT_MS))]);
      await refreshIndex();
      this.render();
    } catch (error) {
      if (this.dialog && !index) {
        this.status.textContent = error.message || "Search isn't available right now.";
      }
    }
  }

  render() {
    if (!this.dialog) {
      return;
    }

    const query = this.input.value.trim();
    const groups = query ? this.results(query) : this.browse();

    this.options = [];
    this.list.replaceChildren(...groups.filter((group) => group.rows.length).map((group) => {
      const item = el("li", "finder-group");
      const heading = el("p", "finder-heading", group.title);
      const rows = el("ul", "finder-rows");

      heading.id = `${this.idPrefix}-g${this.options.length}`;
      item.setAttribute("role", "group");
      item.setAttribute("aria-labelledby", heading.id);
      rows.setAttribute("role", "presentation");
      rows.append(...group.rows.map((row) => this.option(row)));
      item.append(heading, rows);
      return item;
    }));

    if (index) {
      const found = this.options.length;
      this.status.textContent = query && !found ? `Nothing found for "${query}".` : "";
    }

    this.setActive(this.options.length ? 0 : -1);
  }

  // Nothing typed: recent boards, then all boards as a tree.
  browse() {
    if (!index) {
      return [];
    }

    const current = this.getBoardId();
    const recent = readRecent()
      .filter((id) => id !== current && index.boards.has(id))
      .slice(0, SHOWN_RECENT)
      .map((id) => ({ kind: "board", board: index.boards.get(id), words: [], showPath: true }));

    const tree = boardTree(index).map(({ board, depth }) => ({ kind: "board", board, depth, words: [], current: board.id === current }));

    return [
      { title: "Recent boards", rows: recent },
      { title: "All boards", rows: tree }
    ];
  }

  results(query) {
    if (!index) {
      return [];
    }

    const words = queryWords(query);
    const found = search(index, query);
    const current = this.getBoardId();
    const cards = found.cards.map((result) => ({ kind: "card", ...result, words }));

    return [
      { title: "Boards", rows: found.boards.map(({ board }) => ({ kind: "board", board, words, showPath: true, current: board.id === current })) },
      {
        title: found.moreCards ? `Cards (first ${cards.length} of ${cards.length + found.moreCards})` : "Cards",
        rows: cards
      }
    ];
  }

  option(row) {
    const option = el("li", `finder-option finder-${row.kind}`);
    const text = el("span", "finder-text");

    option.id = `${this.idPrefix}-o${this.options.length}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");

    if (row.kind === "board") {
      const { board } = row;

      if (row.depth !== undefined) {
        option.style.setProperty("--depth", String(row.depth));
        option.classList.add("is-tree");
      }

      text.append(marked("finder-title", board.name, row.words));

      if (row.showPath) {
        text.append(el("span", "finder-meta", board.path.length ? board.path.join(" › ") : "Top level"));
      }

      option.append(icon(BOARD_ICON), text);

      if (row.current) {
        option.append(el("span", "finder-badge", "Open"));
        option.setAttribute("aria-current", "page");
      }

      option.addEventListener("click", () => this.choose(row));
    } else {
      const { item } = row;
      const board = index.boards.get(item.boardId);
      const where = board ? [...board.path, board.name].join(" › ") : "";

      if (item.type === "image" && item.ref) {
        const thumb = el("img", "finder-thumb");
        thumb.src = fileUrl(item.ref);
        thumb.alt = "";
        thumb.loading = "lazy";
        option.append(thumb);
      } else {
        option.append(icon(CARD_ICON));
      }

      if (row.inTitle || !item.body.trim()) {
        text.append(marked("finder-title", item.title.trim() ? item.title : item.label, row.words));

        if (item.body.trim()) {
          text.append(markedSnippet("finder-snippet", snippet(item.body, row.words)));
        }
      } else {
        const title = item.title.trim() ? item.title : item.type === "link" ? item.label : typeName(item.type);
        text.append(el("span", "finder-title", title));
        text.append(markedSnippet("finder-snippet", snippet(item.body, row.words)));
      }

      text.append(el("span", "finder-meta", `${typeName(item.type)} on ${where}`));
      option.append(text);
      option.addEventListener("click", () => this.choose(row));
    }

    this.options.push({ element: option, row });
    return option;
  }

  setActive(index_) {
    this.options[this.active]?.element.setAttribute("aria-selected", "false");
    this.active = index_;

    const option = this.options[index_];

    if (option) {
      option.element.setAttribute("aria-selected", "true");
      option.element.scrollIntoView({ block: "nearest" });
      this.input.setAttribute("aria-activedescendant", option.element.id);
    } else {
      this.input.removeAttribute("aria-activedescendant");
    }
  }

  onKeyDown(event) {
    const count = this.options.length;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();

      if (count) {
        this.setActive((this.active + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
      }
    } else if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();

      if (count) {
        const step = event.key === "PageDown" ? 8 : -8;
        this.setActive(Math.max(0, Math.min(count - 1, this.active + step)));
      }
    } else if (event.key === "Enter") {
      event.preventDefault();

      if (this.options[this.active]) {
        this.choose(this.options[this.active].row);
      }
    }
  }

  choose(row) {
    this.close();

    if (row.kind === "board") {
      this.onOpenBoard(row.board.id);
    } else {
      this.onOpenCard(row.item.boardId, row.item.id);
    }
  }
}
