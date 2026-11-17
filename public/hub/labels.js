// Short plain-text descriptions of cards, dates and sizes for lists and
// messages (Recently deleted, Backups, conflict messages). Pure functions:
// the results only ever reach the page as textContent.

const TYPE_NAMES = {
  note: "Note",
  checklist: "Checklist",
  image: "Image",
  link: "Link",
  section: "Section",
  folder: "Folder",
  connector: "Line"
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const typeName = (type) => TYPE_NAMES[type] ?? "Card";

const firstLine = (text) => (typeof text === "string" ? text.split("\n").map((line) => line.trim()).find(Boolean) ?? "" : "");

function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

// The words a card is known by: its title, else its first line of text.
export function cardText(item) {
  const data = item?.data ?? {};

  switch (item?.type) {
    case "note":
      return firstLine(data.title) || firstLine(data.text);
    case "checklist":
      return firstLine(data.title)
        || firstLine((Array.isArray(data.entries) ? data.entries : []).find((entry) => firstLine(entry?.text))?.text);
    case "image":
      return firstLine(data.caption);
    case "link":
      return firstLine(data.title) || hostname(data.url);
    case "section":
      return firstLine(data.title);
    case "folder":
      return firstLine(data.name);
    default:
      return "";
  }
}

// cardText, shortened, or the kind of card when it has no words.
export function cardLabel(item, max = 60) {
  const text = cardText(item);
  return text ? clip(text, max) : typeName(item?.type);
}

// An empty note, checklist or link: nothing worth restoring.
export function isBlankCard(item) {
  const data = item?.data ?? {};
  const blank = (value) => typeof value !== "string" || !value.trim();

  switch (item?.type) {
    case "note":
      return blank(data.title) && blank(data.text);
    case "checklist":
      return blank(data.title) && !(Array.isArray(data.entries) && data.entries.some((entry) => !blank(entry?.text)));
    case "link":
      return blank(data.url) && blank(data.title);
    default:
      return false;
  }
}

// "just now", "5 min ago", "3 h ago", else the date and time.
export function formatWhen(time, now = Date.now()) {
  const age = now - time;

  if (age < MINUTE) {
    return "just now";
  }

  if (age < HOUR) {
    return `${Math.floor(age / MINUTE)} min ago`;
  }

  if (age < 12 * HOUR) {
    return `${Math.floor(age / HOUR)} h ago`;
  }

  return formatDate(time, now);
}

// "Tue 17 Nov, 04:17", with the year when it isn't this year.
export function formatDate(time, now = Date.now()) {
  const date = new Date(time);
  const options = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };

  if (date.getFullYear() !== new Date(now).getFullYear()) {
    options.year = "numeric";
  }

  return date.toLocaleString(undefined, options);
}

export function formatSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const plural = (count, one, many = `${one}s`) => `${count.toLocaleString("en")} ${count === 1 ? one : many}`;
