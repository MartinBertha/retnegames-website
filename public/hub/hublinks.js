// Links to a board or a card in this hub (docs/hub-spec.md, section 6 "Card
// links"): <origin>/hub/#/b/<boardId>, or .../#/b/<boardId>/c/<cardId> for
// one card. In notes and link cards they open in the hub itself and show the
// name of what they point to (namer, set by app.js) instead of the address.

const HASH = /^#\/b\/([0-9a-f-]{36})(?:\/c\/([0-9a-f-]{36}))?$/;

// { boardId, cardId } from a location hash, or null. cardId may be null.
export function parseHubHash(hash) {
  const match = HASH.exec(hash ?? "");
  return match ? { boardId: match[1], cardId: match[2] ?? null } : null;
}

// The board or card an address points to, when it's a link into this hub.
export function hubTarget(href, origin = globalThis.location?.origin) {
  let url;

  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (!origin || url.origin !== origin || !/^\/hub\/?$/.test(url.pathname)) {
    return null;
  }

  return parseHubHash(url.hash);
}

export function hubUrl({ boardId, cardId = null }, origin = globalThis.location?.origin) {
  return `${origin}/hub/#/b/${boardId}${cardId ? `/c/${cardId}` : ""}`;
}

let namer = null;

// namer({ boardId, cardId }) -> { title, where } or null when unknown.
export function setHubLinkNamer(fn) {
  namer = fn;
}

export function hubLinkName(target) {
  return target && namer ? namer(target) : null;
}

// What a hub link shows: the name of the card or board, or what it is.
export function hubLinkText(target) {
  const name = hubLinkName(target);
  return name?.title || (target.cardId ? "Card link" : "Board link");
}

// Its tooltip and second line: where that is.
export function hubLinkPlace(target) {
  const name = hubLinkName(target);

  if (!name) {
    return target.cardId ? "A card in this hub" : "A board in this hub";
  }

  return target.cardId ? `Card on ${name.where}` : `Board${name.where ? ` in ${name.where}` : ""}`;
}
