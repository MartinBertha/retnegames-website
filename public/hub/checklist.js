// Checklist ordering rule (docs/hub-spec.md, section 4): unticked entries
// always come first, ticked entries after. These helpers return new arrays.

const unticked = (entries) => entries.filter((entry) => !entry.done);
const ticked = (entries) => entries.filter((entry) => entry.done);

export function normalizeEntries(entries) {
  return [...unticked(entries), ...ticked(entries)];
}

// Ticking moves an entry to the very bottom; unticking moves it to the top
// of the unticked group.
export function toggleEntry(entries, id) {
  const entry = entries.find((candidate) => candidate.id === id);

  if (!entry) {
    return entries;
  }

  const rest = entries.filter((candidate) => candidate !== entry);
  const updated = { ...entry, done: !entry.done };

  return updated.done
    ? [...unticked(rest), ...ticked(rest), updated]
    : [updated, ...unticked(rest), ...ticked(rest)];
}

// New entries go to the bottom of the unticked group.
export function addEntry(entries, entry) {
  return [...unticked(entries), { ...entry, done: false }, ...ticked(entries)];
}

export function removeEntry(entries, id) {
  return entries.filter((entry) => entry.id !== id);
}

// Reorders within the unticked group; ticked entries can't be moved.
export function moveEntry(entries, id, toIndex) {
  const open = unticked(entries);
  const from = open.findIndex((entry) => entry.id === id);

  if (from === -1) {
    return entries;
  }

  const [moved] = open.splice(from, 1);
  open.splice(Math.max(0, Math.min(open.length, toIndex)), 0, moved);
  return [...open, ...ticked(entries)];
}
