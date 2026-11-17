// Searching the hub (docs/hub-spec.md, section 6 "Search and Go to"): the
// index from GET /index, matched as you type. Every word typed must appear
// (in any order); case and accents don't matter. Boards match by name (or
// by the boards they're in, ranked lower); cards by their title and words.
// Pure functions: no DOM.

import { cardLabel } from "./labels.js";

const MARKS = /\p{M}+/gu;
const ASCII = /^[\x00-\x7f]*$/;
const SNIPPET_BEFORE = 40;
const SNIPPET_LENGTH = 140;
// Cards whose type the search finds (folders are found as boards).
const SEARCHABLE = new Set(["note", "checklist", "image", "link", "section"]);

// Lower case without accents, for matching.
export function fold(text) {
  return ASCII.test(text) ? text.toLowerCase() : text.normalize("NFD").replace(MARKS, "").toLowerCase();
}

// fold() with, for every folded character, where it came from in `text`
// (map[i]), so matches can be marked in the original.
export function foldWithMap(text) {
  if (ASCII.test(text)) {
    return { folded: text.toLowerCase(), map: null };
  }

  let folded = "";
  const map = [];

  for (let index = 0; index < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(index));
    const part = char.normalize("NFD").replace(MARKS, "").toLowerCase();

    for (let k = 0; k < part.length; k++) {
      map.push(index);
    }

    folded += part;
    index += char.length;
  }

  map.push(text.length);
  return { folded, map };
}

export function queryWords(query) {
  return fold(query).split(/\s+/).filter(Boolean);
}

// Each board's path of names from Home, guarded against loops.
function boardPath(boards, board) {
  const names = [];
  const seen = new Set();

  for (let current = boards.get(board.parentId); current && !seen.has(current.id); current = boards.get(current.parentId)) {
    seen.add(current.id);
    names.unshift(current.name);
  }

  return names;
}

// GET /index's answer, ready to search.
export function prepareIndex(data) {
  const boards = new Map((data?.boards ?? []).map((board) => [board.id, { ...board }]));

  for (const board of boards.values()) {
    board.path = boardPath(boards, board);
    board.foldedName = fold(board.name);
    board.foldedPath = fold(board.path.join(" "));
  }

  const items = (data?.items ?? []).filter((item) => boards.has(item.boardId)).map((item) => {
    const card = {
      ...item,
      label: cardLabel(cardLike(item), 80)
    };

    card.foldedTitle = fold(item.title);
    card.foldedBody = fold(item.body);
    return card;
  });

  return {
    rootId: data?.rootId ?? null,
    boards,
    items,
    itemsById: new Map(items.map((item) => [item.id, item]))
  };
}

// Enough of a card's shape for labels.js.
function cardLike(item) {
  switch (item.type) {
    case "note":
      return { type: "note", data: { title: item.title, text: item.body } };
    case "checklist":
      return { type: "checklist", data: { title: item.title, entries: item.body.split("\n").map((text) => ({ text })) } };
    case "image":
      return { type: "image", data: { caption: item.title } };
    case "link":
      return { type: "link", data: { title: item.title, url: item.body } };
    case "folder":
      return { type: "folder", data: { name: item.title } };
    default:
      return { type: item.type, data: { title: item.title } };
  }
}

const startsWord = (folded, word) => {
  let at = folded.indexOf(word);

  while (at !== -1) {
    if (at === 0 || !/[\p{L}\p{N}]/u.test(folded[at - 1])) {
      return true;
    }

    at = folded.indexOf(word, at + 1);
  }

  return false;
};

const hasAll = (folded, words) => words.every((word) => folded.includes(word));

// { boards: [{ board, score }], cards: [{ item, score, inTitle }], moreCards }
export function search(index, query, { maxBoards = 8, maxCards = 40 } = {}) {
  const words = queryWords(query);

  if (!index || !words.length) {
    return { boards: [], cards: [], moreCards: 0 };
  }

  const boards = [];

  for (const board of index.boards.values()) {
    let score = 0;

    if (hasAll(board.foldedName, words)) {
      score = 100;
      score += board.foldedName.startsWith(words[0]) ? 50 : 0;
      score += words.every((word) => startsWord(board.foldedName, word)) ? 20 : 0;
    } else if (hasAll(`${board.foldedPath} ${board.foldedName}`, words)) {
      score = 30;
    }

    if (score) {
      boards.push({ board, score });
    }
  }

  const cards = [];

  for (const item of index.items) {
    if (!SEARCHABLE.has(item.type)) {
      continue;
    }

    const inTitle = hasAll(item.foldedTitle, words);
    let score = 0;

    if (inTitle) {
      score = 100 + (item.foldedTitle.startsWith(words[0]) ? 30 : 0);
    } else if (hasAll(`${item.foldedTitle}\n${item.foldedBody}`, words)) {
      score = 40;
    }

    if (score) {
      const haystack = `${item.foldedTitle}\n${item.foldedBody}`;
      score += words.every((word) => startsWord(haystack, word)) ? 10 : 0;
      cards.push({ item, score, inTitle });
    }
  }

  const byScore = (a, b) => b.score - a.score || (b.item ?? b.board).updatedAt - (a.item ?? a.board).updatedAt;
  boards.sort(byScore);
  cards.sort(byScore);

  return {
    boards: boards.slice(0, maxBoards),
    cards: cards.slice(0, maxCards),
    moreCards: Math.max(0, cards.length - maxCards)
  };
}

// Where the words occur in `text`: [start, end] pairs in the original text,
// sorted and not overlapping.
export function matchRanges(text, words) {
  const { folded, map } = foldWithMap(text);
  const at = (i) => (map ? map[i] : i);
  const ranges = [];

  for (const word of words) {
    for (let found = folded.indexOf(word); found !== -1; found = folded.indexOf(word, found + word.length)) {
      ranges.push([at(found), at(found + word.length)]);
    }
  }

  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];

  for (const range of ranges) {
    const last = merged.at(-1);

    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([...range]);
    }
  }

  return merged;
}

// A short, single-line piece of `text` around the first match, with its
// match ranges: { text, ranges }. Text before or after is cut with "…".
export function snippet(text, words, { before = SNIPPET_BEFORE, length = SNIPPET_LENGTH } = {}) {
  // Lines (checklist items, paragraphs) are kept apart by " · ".
  const flat = text.trim().replace(/\s*\n\s*/g, " · ").replace(/\s+/g, " ");
  const all = matchRanges(flat, words);
  const first = all[0]?.[0] ?? 0;
  let start = Math.max(0, first - before);

  // Start at a word.
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    start = space !== -1 && space < first ? space + 1 : start;
  }

  const end = Math.min(flat.length, start + length);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  const shift = prefix.length - start;

  return {
    text: `${prefix}${flat.slice(start, end)}${suffix}`,
    ranges: all
      .filter(([from, to]) => to > start && from < end)
      .map(([from, to]) => [Math.max(from, start) + shift, Math.min(to, end) + shift])
  };
}

// Splits text into [{ text, mark }] pieces for the given ranges.
export function segments(text, ranges) {
  const pieces = [];
  let at = 0;

  for (const [from, to] of ranges) {
    if (from > at) {
      pieces.push({ text: text.slice(at, from), mark: false });
    }

    pieces.push({ text: text.slice(from, to), mark: true });
    at = to;
  }

  if (at < text.length) {
    pieces.push({ text: text.slice(at), mark: false });
  }

  return pieces;
}

// Every board under Home, depth first, children by name: [{ board, depth }].
export function boardTree(index) {
  if (!index?.rootId || !index.boards.has(index.rootId)) {
    return [];
  }

  const children = new Map();

  for (const board of index.boards.values()) {
    if (board.parentId) {
      children.set(board.parentId, [...(children.get(board.parentId) ?? []), board]);
    }
  }

  for (const list of children.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  }

  const rows = [];
  const seen = new Set();
  const visit = (board, depth) => {
    if (seen.has(board.id)) {
      return;
    }

    seen.add(board.id);
    rows.push({ board, depth });

    for (const child of children.get(board.id) ?? []) {
      visit(child, depth + 1);
    }
  };

  visit(index.boards.get(index.rootId), 0);
  return rows;
}
