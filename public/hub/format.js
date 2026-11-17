// Light formatting in a note's text (docs/hub-spec.md, section 6 "Formatting"),
// drawn by the page while the stored text stays plain:
//   # Heading, ## Smaller heading, ### Smallest heading   (a whole line)
//   **bold**  *italic* or _italic_  ~~struck through~~  `code`
// Markers only count around words ("2 * 3 * 4" and snake_case_names stay as
// they are), code is shown as typed, and web addresses are links whatever
// characters they contain. Pure functions: no DOM.

const URL_PATTERN = /https?:\/\/[^\s<>"]+/gi;
// Characters that end a sentence or a format rather than an address.
const TRAILING = ".,;:!?'*_~`";
const OPEN = "";
const CLOSE = "";
const PLACEHOLDER = /(\d+)/g;
const HEADING = /^(#{1,3})[ \t]+(\S.*)$/;

const INLINE = new RegExp([
  "`([^`\\n]+)`",
  "\\*\\*(?=\\S)([^\\n]*?\\S)\\*\\*",
  "~~(?=\\S)([^\\n]*?\\S)~~",
  "(?<![\\p{L}\\p{N}*])\\*(?=[^\\s*])([^\\n*]*?[^\\s*])\\*(?![\\p{L}\\p{N}*])",
  "(?<![\\p{L}\\p{N}_])_(?=[^\\s_])([^\\n_]*?[^\\s_])_(?![\\p{L}\\p{N}_])"
].join("|"), "gu");

// "See https://example.com/a_(b)." -> "https://example.com/a_(b)".
export function trimUrl(raw) {
  let url = raw;

  for (;;) {
    const last = url.at(-1);
    const opens = url.split("(").length;
    const closes = url.split(")").length;

    if (TRAILING.includes(last) || (last === ")" && closes > opens)) {
      url = url.slice(0, -1);
    } else {
      return url;
    }
  }
}

// "# Title" -> { level: 1, text: "Title" }; null for other lines.
export function lineHeading(line) {
  const match = HEADING.exec(line);
  return match ? { level: match[1].length, text: match[2] } : null;
}

const restore = (text, urls) => text.replace(PLACEHOLDER, (match, index) => urls[Number(index)]);

function pushText(tokens, text, flags, urls) {
  const parts = text.split(/(\d+)/);

  parts.forEach((part, index) => {
    if (index % 2) {
      tokens.push({ ...flags, type: "url", text: urls[Number(part)] });
    } else if (part) {
      tokens.push({ ...flags, type: "text", text: part });
    }
  });
}

function parse(text, flags, tokens, urls) {
  let last = 0;

  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) {
      pushText(tokens, text.slice(last, match.index), flags, urls);
    }

    const [, code, bold, strike, star, underscore] = match;

    if (code !== undefined) {
      tokens.push({ ...flags, type: "text", code: true, text: restore(code, urls) });
    } else if (bold !== undefined) {
      parse(bold, { ...flags, bold: true }, tokens, urls);
    } else if (strike !== undefined) {
      parse(strike, { ...flags, strike: true }, tokens, urls);
    } else {
      parse(star ?? underscore, { ...flags, italic: true }, tokens, urls);
    }

    last = match.index + match[0].length;
  }

  if (last < text.length) {
    pushText(tokens, text.slice(last), flags, urls);
  }
}

// One line of text as pieces: { type: "text" | "url", text, bold?, italic?,
// strike?, code? }. A url piece's text is the address (http or https).
export function formatLine(line) {
  const urls = [];
  const masked = line.replace(/[]/g, "").replace(URL_PATTERN, (match) => {
    const label = trimUrl(match);
    urls.push(label);
    return `${OPEN}${urls.length - 1}${CLOSE}${match.slice(label.length)}`;
  });
  const tokens = [];

  parse(masked, {}, tokens, urls);
  return tokens;
}
