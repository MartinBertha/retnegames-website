// What can be styled on each kind of object, and how a style is stored and
// drawn (docs/hub-spec.md, section 6, "Property column"). Pure data and helpers,
// no DOM. The server checks the same limits (src/hub/validate.js); a test keeps
// the two in step.
//
// A style lives in the object's data:
//   item.color           the fill (a note's background, a folder's icon, a line's colour)
//   data.style.alpha     75, 50 or 25 (percent opaque; absent means 100)
//   data.style[set]      the text properties of one piece of text on the object:
//                        { color, font, size, bold, italic, list, align, valign }
// Only values that differ from the default are stored, so objects that were
// never styled look exactly as they always did.

// The 16 colours: the default (the theme's own) and 15 keys. The first eight
// of these were the original palette, so existing objects keep theirs.
export const COLOR_KEYS = [
  "grey", "slate", "brown", "sand", "red", "pink", "orange", "yellow",
  "lime", "green", "teal", "cyan", "blue", "indigo", "purple"
];

export const COLOR_NAMES = {
  grey: "Grey",
  slate: "Slate",
  brown: "Brown",
  sand: "Sand",
  red: "Red",
  pink: "Pink",
  orange: "Orange",
  yellow: "Yellow",
  lime: "Lime",
  green: "Green",
  teal: "Teal",
  cyan: "Cyan",
  blue: "Blue",
  indigo: "Indigo",
  purple: "Purple"
};

// System fonts only (the hub's rule); the stacks are --font-sans, --font-serif
// and --font-mono in hub.css.
export const FONT_NAMES = { sans: "Sans", serif: "Serif", mono: "Mono" };
export const SIZE_NAMES = { s: "Small", m: "Medium", l: "Large", xl: "Extra large" };
export const ALIGN_NAMES = { left: "Align left", center: "Align centre", right: "Align right" };
export const VALIGN_NAMES = { top: "Align to top", middle: "Align to middle", bottom: "Align to bottom" };
// How a piece of text is listed: plain, or every line an item with a bullet, a
// number or a letter. A list is always left-aligned.
export const LIST_NAMES = { none: "None", bullet: "Bullet list", number: "Numbered list", alpha: "Alphabet list" };

// How opaque a fill (or an image, or a line) can be, in percent.
export const ALPHAS = [100, 75, 50, 25];

// Each object type offers a fill (for the colour in item.color), an opacity,
// one entry per piece of text, and some `extras` of its own (a border, a flip,
// a line's thickness...). `bold` is whether that text is bold by default;
// `props` is what can be changed about it (besides the usual ones, "strike"
// for ticked checklist items and "address" for a link's address line);
// `valign` is its default vertical alignment where it has one. An extra is
// stored as data.style[key]; `kind` is "choice" (one of `options`), "color" or
// "toggle"; `default` is what it is when nothing is stored (a function of the
// item where that depends on the object); `group` and `row` say where the bar
// puts it; `icons` shows a choice's options as small drawings instead of words;
// `when` hides it while it would have no effect.
export const OBJECT_STYLES = {
  note: {
    heading: "Fill",
    fill: "Fill",
    palette: "tone",
    alpha: "Fill opacity",
    sets: [
      { key: "title", label: "Title", bold: true, props: ["color", "font", "size", "bold", "italic", "align"] },
      { key: "body", label: "Body", bold: false, valign: "top", props: ["color", "font", "size", "bold", "italic", "list", "align", "valign"] }
    ]
  },
  checklist: {
    heading: "Fill",
    fill: "Fill",
    palette: "tone",
    alpha: "Fill opacity",
    sets: [
      { key: "title", label: "Title", bold: true, props: ["color", "font", "size", "bold", "italic"] },
      { key: "items", label: "Items", bold: false, props: ["color", "font", "size", "bold", "italic", "strike"] }
    ],
    extras: [
      { key: "hideDone", kind: "toggle", label: "Hide ticked items", icon: "hideDone", default: false, group: "Ticked items" }
    ]
  },
  image: {
    heading: "Image",
    alpha: "Opacity",
    sets: [
      { key: "caption", label: "Caption", bold: false, props: ["size", "align"] }
    ],
    extras: [
      { key: "flipX", kind: "toggle", label: "Flip horizontally", icon: "flipX", default: false, group: "Image", row: "flip" },
      { key: "flipY", kind: "toggle", label: "Flip vertically", icon: "flipY", default: false, group: "Image", row: "flip" },
      { key: "border", kind: "choice", label: "Border", options: { none: "None", thin: "Thin", thick: "Thick" }, default: "none", group: "Frame" },
      {
        key: "borderColor",
        kind: "color",
        label: "Border colour",
        palette: "ink",
        default: null,
        group: "Frame",
        when: (item) => (item.data.style?.border ?? "none") !== "none"
      },
      { key: "corners", kind: "choice", label: "Corners", options: { square: "Square", rounded: "Rounded" }, icons: true, default: "square", group: "Frame" }
    ]
  },
  link: {
    heading: "Fill",
    fill: "Fill",
    palette: "tone",
    alpha: "Fill opacity",
    sets: [
      { key: "text", label: "Text", bold: true, valign: "middle", props: ["color", "font", "size", "bold", "italic", "align", "valign", "address"] }
    ]
  },
  section: {
    heading: "Fill",
    fill: "Fill",
    palette: "tone",
    alpha: "Fill opacity",
    sets: [
      { key: "title", label: "Title", bold: true, props: ["color", "font", "size", "align"] }
    ],
    extras: [
      {
        key: "border",
        kind: "choice",
        label: "Border",
        options: { dashed: "Dashed", solid: "Solid", none: "None" },
        // A section with a colour has always had a solid border, a plain one a dashed border.
        default: (item) => (item.color ? "solid" : "dashed"),
        group: "Border"
      }
    ]
  },
  folder: {
    heading: "Icon",
    fill: "Icon colour",
    palette: "tone",
    sets: [
      { key: "label", label: "Label", bold: false, sizes: ["s", "m", "l"], props: ["color", "size", "bold"] }
    ]
  },
  connector: {
    heading: "Line",
    fill: "Colour",
    palette: "ink",
    alpha: "Opacity",
    shape: true,
    sets: [],
    extras: [
      { key: "thickness", kind: "choice", label: "Thickness", options: { thin: "Thin", medium: "Medium", thick: "Thick" }, icons: true, default: "medium", group: "Stroke" },
      { key: "dash", kind: "choice", label: "Line style", options: { solid: "Solid", dashed: "Dashed", dotted: "Dotted" }, icons: true, default: "solid", group: "Stroke" },
      {
        key: "arrow",
        kind: "choice",
        label: "Arrowhead",
        options: { none: "None", end: "End", start: "Start", both: "Both" },
        icons: true,
        default: "end",
        group: "Stroke"
      }
    ]
  }
};

export const extrasOf = (type) => OBJECT_STYLES[type]?.extras ?? [];

const ALL_SIZES = ["s", "m", "l", "xl"];

export const sizesOf = (set) => set.sizes ?? ALL_SIZES;

// Text sizes in pixels per piece of text; M is what the object looked like
// before sizes could be changed.
const SIZE_PX = {
  "note.title": { s: 17, m: 20, l: 28, xl: 36 },
  "note.body": { s: 14, m: 16, l: 22, xl: 28 },
  "checklist.title": { s: 16, m: 19, l: 24, xl: 30 },
  "checklist.items": { s: 12, m: 14, l: 18, xl: 22 },
  "image.caption": { s: 11, m: 13, l: 16, xl: 20 },
  "link.text": { s: 13, m: 15, l: 19, xl: 24 },
  "section.title": { s: 18, m: 22, l: 28, xl: 36 },
  "folder.label": { s: 13, m: 15, l: 19 }
};

const isPlain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const setsOf = (type) => OBJECT_STYLES[type]?.sets ?? [];

function setOf(type, key) {
  return setsOf(type).find((set) => set.key === key);
}

// Opacity of the fill (or image, or line) in percent.
export function alphaOf(item) {
  return item.data.style?.alpha ?? 100;
}

function extraOf(type, key) {
  return extrasOf(type).find((extra) => extra.key === key);
}

// What an extra is when nothing is stored.
export function defaultExtra(item, key) {
  const { default: fallback } = extraOf(item.type, key);
  return typeof fallback === "function" ? fallback(item) : fallback;
}

export function extraValue(item, key) {
  return item.data.style?.[key] ?? defaultExtra(item, key);
}

// Sets an extra (storing it only when it differs from the default).
export function setExtra(item, key, value) {
  if (value === defaultExtra(item, key)) {
    if (item.data.style) {
      delete item.data.style[key];
      prune(item, key);
    }

    return;
  }

  item.data.style = { ...item.data.style, [key]: value };
}

// The default of one text property: what it is when nothing is stored.
// A note's title follows the note's own size until it is set separately
// (notes made before titles had their own size are sized as a whole).
export function defaultText(item, key, prop) {
  const set = setOf(item.type, key);

  switch (prop) {
    case "color":
      return null;
    case "font":
      return "sans";
    case "size":
      return item.type === "note" && key === "title" ? item.data.size ?? "m" : "m";
    case "bold":
      return set.bold;
    case "italic":
    case "strike":
      return false;
    case "address":
      return true;
    case "align":
      return "left";
    case "list":
      return "none";
    default:
      return set.valign;
  }
}

// Whether a piece of text is a list (so it is left-aligned, whatever its
// stored alignment, which comes back when the list goes).
export function isList(item, key) {
  return Boolean(setOf(item.type, key)?.props.includes("list")) && textValue(item, key, "list") !== "none";
}

// What a text property is now.
export function textValue(item, key, prop) {
  // A note's body size has always been stored as data.size.
  if (item.type === "note" && key === "body" && prop === "size") {
    return item.data.size ?? "m";
  }

  return item.data.style?.[key]?.[prop] ?? defaultText(item, key, prop);
}

function prune(item, key) {
  const { style } = item.data;

  if (style && style[key] && !Object.keys(style[key]).length) {
    delete style[key];
  }

  if (style && !Object.keys(style).length) {
    delete item.data.style;
  }
}

// Sets a text property, storing it only when it differs from the default.
export function setTextValue(item, key, prop, value) {
  if (item.type === "note" && key === "body" && prop === "size") {
    // The title was sized along with the body; keep it as it is.
    const title = item.data.style?.title;

    if (!title || title.size === undefined) {
      item.data.style = { ...item.data.style, title: { ...title, size: item.data.size ?? "m" } };
    }

    item.data.size = value;

    if (item.data.style.title.size === value) {
      delete item.data.style.title.size;
    }

    prune(item, "title");
    return;
  }

  const fallback = defaultText(item, key, prop);

  if (value === fallback || (prop === "color" && value == null)) {
    if (item.data.style?.[key]) {
      delete item.data.style[key][prop];
      prune(item, key);
    }

    return;
  }

  item.data.style = { ...item.data.style };
  item.data.style[key] = { ...item.data.style[key], [prop]: value };
}

export function setAlpha(item, percent) {
  if (percent === 100) {
    if (item.data.style) {
      delete item.data.style.alpha;
      prune(item, "alpha");
    }

    return;
  }

  item.data.style = { ...item.data.style, alpha: percent };
}

const FLEX = { top: "flex-start", middle: "center", bottom: "flex-end" };
// Room for the marker of a list item (in em, so it follows the text size).
const LIST_INDENT = "1.6em";

// The CSS custom properties that draw an object's style, set on its element;
// only what differs from the stylesheet's own defaults. hub.css reads them as
// var(--title-size, 20px) and so on.
export function styleVars(item) {
  const vars = {};
  const alpha = alphaOf(item);

  if (alpha !== 100) {
    vars["--alpha"] = String(alpha / 100);
  }

  for (const set of setsOf(item.type)) {
    const name = `--${set.key}`;
    const value = (prop) => textValue(item, set.key, prop);

    if (set.props.includes("color") && value("color")) {
      vars[`${name}-color`] = `var(--ink-${value("color")})`;
    }

    if (set.props.includes("font") && value("font") !== "sans") {
      vars[`${name}-font`] = `var(--font-${value("font")})`;
    }

    if (set.props.includes("size") && value("size") !== "m") {
      const size = value("size");
      vars[`${name}-size`] = `${SIZE_PX[`${item.type}.${set.key}`][size]}px`;

      // Big note text sits closer together.
      if (item.type === "note" && set.key === "body" && (size === "l" || size === "xl")) {
        vars[`${name}-leading`] = "1.3";
      }
    }

    if (set.props.includes("bold") && value("bold") !== set.bold) {
      vars[`${name}-weight`] = value("bold") ? "700" : "400";
    }

    if (set.props.includes("italic") && value("italic")) {
      vars[`${name}-style`] = "italic";
    }

    // Ticked checklist items struck through; a link's address line hidden.
    if (set.props.includes("strike") && value("strike")) {
      vars[`${name}-strike`] = "line-through";
    }

    if (set.props.includes("address") && !value("address")) {
      vars[`${name}-address`] = "none";
    }

    // A list: the lines are indented to make room for their markers (the
    // editor is indented the same), and the text is left-aligned.
    const listed = isList(item, set.key);

    if (listed) {
      vars[`${name}-indent`] = LIST_INDENT;
    }

    if (set.props.includes("align") && value("align") !== "left" && !listed) {
      vars[`${name}-align`] = value("align");
    }

    if (set.props.includes("valign") && value("valign") !== set.valign) {
      vars[`${name}-valign`] = FLEX[value("valign")];
    }
  }

  Object.assign(vars, extraVars(item));
  return vars;
}

// A line's thickness, in pixels, and its dashes: a dash and a gap, in
// multiples of the thickness (a dot is a dash of nothing with round ends).
const STROKE_PX = { thin: "1.5px", medium: "2px", thick: "3.5px" };
const DASHES = { dashed: ["4", "3"], dotted: ["0.01", "2.2"] };
const BORDER_PX = { thin: "2px", thick: "5px" };
const CORNER_PX = "16px";

// The custom properties for the extras (borders, corners, flips, strokes).
function extraVars(item) {
  const vars = {};
  const changed = (key) => item.data.style?.[key] !== undefined && extraValue(item, key) !== defaultExtra(item, key);

  if (item.type === "image") {
    const border = extraValue(item, "border");

    if (border !== "none") {
      vars["--border-width"] = BORDER_PX[border];
      vars["--border-color"] = extraValue(item, "borderColor") ? `var(--ink-${extraValue(item, "borderColor")})` : "var(--text)";
    }

    if (extraValue(item, "corners") === "rounded") {
      vars["--corner"] = CORNER_PX;
    }

    if (extraValue(item, "flipX")) {
      vars["--flip-x"] = "-1";
    }

    if (extraValue(item, "flipY")) {
      vars["--flip-y"] = "-1";
    }
  } else if (item.type === "section" && changed("border")) {
    const border = extraValue(item, "border");

    if (border === "none") {
      vars["--border-color"] = "transparent";
    } else {
      vars["--border-style"] = border;
    }
  } else if (item.type === "connector") {
    if (changed("thickness")) {
      vars["--stroke"] = STROKE_PX[extraValue(item, "thickness")];
    }

    const dash = DASHES[extraValue(item, "dash")];

    if (dash) {
      vars["--dash-on"] = dash[0];
      vars["--dash-off"] = dash[1];

      if (extraValue(item, "dash") === "dotted") {
        vars["--cap"] = "round";
      }
    }
  }

  return vars;
}

const VALUES = {
  color: COLOR_KEYS,
  font: Object.keys(FONT_NAMES),
  size: ALL_SIZES,
  align: Object.keys(ALIGN_NAMES),
  valign: Object.keys(VALIGN_NAMES),
  list: Object.keys(LIST_NAMES)
};

function validProp(set, prop, value) {
  if (!set.props.includes(prop)) {
    return false;
  }

  if (prop === "bold" || prop === "italic" || prop === "strike" || prop === "address") {
    return typeof value === "boolean";
  }

  return prop === "size" ? sizesOf(set).includes(value) : VALUES[prop].includes(value);
}

// A style with anything unknown or out of range dropped (copied cards come
// from the clipboard); undefined when nothing is left.
export function sanitizeStyle(type, style) {
  if (!isPlain(style) || !OBJECT_STYLES[type]) {
    return undefined;
  }

  const clean = {};

  if (OBJECT_STYLES[type].alpha && ALPHAS.includes(style.alpha) && style.alpha !== 100) {
    clean.alpha = style.alpha;
  }

  for (const set of setsOf(type)) {
    if (!isPlain(style[set.key])) {
      continue;
    }

    const text = {};

    for (const [prop, value] of Object.entries(style[set.key])) {
      if (validProp(set, prop, value)) {
        text[prop] = value;
      }
    }

    if (Object.keys(text).length) {
      clean[set.key] = text;
    }
  }

  for (const extra of extrasOf(type)) {
    const value = style[extra.key];
    const valid = extra.kind === "toggle" ? typeof value === "boolean"
      : extra.kind === "color" ? COLOR_KEYS.includes(value)
        : Object.keys(extra.options).includes(value);

    if (value !== undefined && valid) {
      clean[extra.key] = value;
    }
  }

  return Object.keys(clean).length ? clean : undefined;
}
