// Merging a card that was changed on two devices (docs/hub-spec.md, section 6
// "Saving"). Every save says which stored version of the card it was made
// from; when the card has changed since (on another device), the server
// doesn't apply the save and sends back what it has. The three versions are
// then merged here: `base` (what both devices started from), `local` (this
// device) and `server` (the other device).
//
// Each property takes the side that changed it. When both changed the same
// one, this device wins, except for a card's content (its text, titles,
// checklist items, link, caption): then the other device's version is kept
// too, as a copy next to the card, so nothing typed is lost. Checklist items
// merge one by one. Pure functions: no DOM.

// Content that is never silently overwritten: a clash makes a copy.
export const CONTENT_KEYS = {
  note: ["title", "text"],
  checklist: ["title", "entries"],
  link: ["url", "title"],
  image: ["caption"]
};

// What counts as "changed here" for a card deleted on the other device: with
// any of these changed, the card is kept.
const TEXT_KEYS = {
  ...CONTENT_KEYS,
  section: ["title"],
  folder: ["name"]
};

const GEOMETRY = ["x", "y", "w", "h", "z", "color"];
const COORDINATE_LIMIT = 1_000_000;
const GRID = 24;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isBlank = (value) => value === undefined
  || value === null
  || value === ""
  || value === false
  || (Array.isArray(value) && value.length === 0)
  || (isObject(value) && Object.values(value).every(isBlank));

const plainText = (text) => text.replace(/\r\n?/g, "\n").trim();

// Equal as the server stores them: text compares without surrounding spaces,
// and a missing value equals an empty one ("", false, [], {}).
export function same(a, b) {
  if (isBlank(a) && isBlank(b)) {
    return true;
  }

  if (typeof a === "string" && typeof b === "string") {
    return plainText(a) === plainText(b);
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => same(value, b[index]));
  }

  if (isObject(a) && isObject(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) => same(a[key], b[key]));
  }

  return a === b;
}

// A card's position, size, order, colour and data.
export function sameCard(a, b) {
  return GEOMETRY.every((key) => same(a?.[key], b?.[key])) && same(a?.data, b?.data);
}

// Three-way merge of one value: { value, conflict }. Objects merge key by key.
function merge3(base, local, server) {
  if (same(local, base)) {
    return { value: server, conflict: false };
  }

  if (same(server, base) || same(local, server)) {
    return { value: local, conflict: false };
  }

  if (isObject(local) && isObject(server)) {
    const value = {};
    let conflict = false;

    for (const key of new Set([...Object.keys(local), ...Object.keys(server), ...Object.keys(isObject(base) ? base : {})])) {
      const result = merge3(isObject(base) ? base[key] : undefined, local[key], server[key]);

      if (result.value !== undefined) {
        value[key] = result.value;
      }

      conflict ||= result.conflict;
    }

    return { value, conflict };
  }

  return { value: local, conflict: true };
}

const entriesById = (entries) => new Map((Array.isArray(entries) ? entries : []).map((entry) => [entry.id, entry]));

// Checklist items merge by id: added on either side, ticked on either side,
// removed where the other side didn't change them. Only the same item's text
// changed differently on both sides is a clash. Unticked items stay first.
function mergeEntries(base, local, server) {
  const b = entriesById(base);
  const l = entriesById(local);
  const s = entriesById(server);
  const order = [...l.keys(), ...[...s.keys()].filter((id) => !l.has(id))];
  const merged = [];
  let conflict = false;

  for (const id of order) {
    const was = b.get(id);
    const here = l.get(id);
    const there = s.get(id);

    if (here && there) {
      if (!was) {
        merged.push(here);
        continue;
      }

      const text = merge3(was.text, here.text, there.text);
      const done = merge3(was.done, here.done, there.done);
      conflict ||= text.conflict;
      merged.push({ id, text: text.value ?? "", done: Boolean(done.value) });
    } else if (here) {
      // Added here, or removed there after it was changed here.
      if (!was || !same(here, was)) {
        merged.push(here);
      }
    } else if (!was || !same(there, was)) {
      // Added there, or removed here after it was changed there.
      merged.push(there);
    }
  }

  return {
    value: [...merged.filter((entry) => !entry.done), ...merged.filter((entry) => entry.done)],
    conflict
  };
}

// Merges a card's three versions. Without a base, this device wins
// everywhere and every difference in the data counts as a clash.
// Returns { item, conflicts } (conflicts: the data keys that clashed).
export function mergeCards(base, local, server) {
  const item = { id: local.id, type: local.type };
  const conflicts = new Set();

  for (const key of GEOMETRY) {
    item[key] = base ? merge3(base[key], local[key], server[key]).value : local[key];
  }

  item.color ??= null;

  const data = {};
  const localData = local.data ?? {};
  const serverData = server.data ?? {};
  const baseData = base?.data ?? {};

  for (const key of new Set([...Object.keys(localData), ...Object.keys(serverData), ...Object.keys(baseData)])) {
    let result;

    if (!base) {
      result = { value: localData[key], conflict: !same(localData[key], serverData[key]) };
    } else if (local.type === "checklist" && key === "entries") {
      result = mergeEntries(baseData.entries, localData.entries, serverData.entries);
    } else {
      result = merge3(baseData[key], localData[key], serverData[key]);
    }

    if (result.value !== undefined) {
      data[key] = result.value;
    }

    if (result.conflict) {
      conflicts.add(key);
    }
  }

  item.data = data;
  return { item, conflicts };
}

const clampCoordinate = (value) => Math.round(Math.min(COORDINATE_LIMIT, Math.max(-COORDINATE_LIMIT, value)));

// The other device's version as a new card, on the grid just right of `beside`.
function copyBeside(server, beside, { newId, z }) {
  const copy = structuredClone({
    id: newId(),
    type: server.type,
    x: clampCoordinate(Math.ceil((beside.x + beside.w + GRID) / GRID) * GRID),
    y: beside.y,
    w: server.w,
    h: server.h,
    z,
    color: server.color ?? null,
    data: server.data
  });

  if (copy.type === "checklist") {
    copy.data.entries = copy.data.entries.map((entry) => ({ ...entry, id: newId() }));
  }

  return copy;
}

// What to do with a card the server reported changed since `base`:
//   { item, copy, outcome }
// item: what to save for the card (null: let the other device's delete stand);
// copy: the other device's version as a new card, or null.
// outcome: "merged" (no clash), "copied" (a clash: both versions kept),
// "kept" (deleted there, but changed here, so kept) or "removed".
// editing: the card is open in an editor here, so its local version is kept
// as it is (and any content changed there goes into the copy).
export function resolveConflict({ base, local, server, deleted, editing = false }, { newId, z }) {
  if (deleted) {
    const keys = TEXT_KEYS[local.type] ?? [];
    const changed = editing || !base || keys.some((key) => !same(local.data?.[key], base.data?.[key]));
    return changed
      ? { item: local, copy: null, outcome: "kept" }
      : { item: null, copy: null, outcome: "removed" };
  }

  const content = CONTENT_KEYS[local.type] ?? [];
  const { item: merged, conflicts } = mergeCards(base, local, server);
  const item = editing ? local : merged;
  const clash = editing
    ? content.some((key) => !same(local.data?.[key], server.data?.[key])
      && (!base || !same(server.data?.[key], base.data?.[key])))
    : content.some((key) => conflicts.has(key));

  if (!clash) {
    return { item, copy: null, outcome: "merged" };
  }

  return { item, copy: copyBeside(server, item, { newId, z: z ?? server.z + 1 }), outcome: "copied" };
}
