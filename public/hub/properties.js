// The property bar (docs/hub-spec.md, section 6): shown over the left edge of
// the canvas (a strip above the toolbar on phones) while one or more objects
// of the same kind are selected, with the properties that kind offers
// (styles.js): fill, opacity, and the style of each piece of text. A control
// shows the value all selected objects share, or nothing when they differ.
// Choices go to onChange({ kind, set, prop, value }); the board applies them.
// Colours open a grid of the 16 colours. Everything is built with
// createElement; nothing is rendered from data as HTML.

import {
  ALIGN_NAMES,
  ALPHAS,
  COLOR_KEYS,
  COLOR_NAMES,
  FONT_NAMES,
  OBJECT_STYLES,
  SIZE_NAMES,
  VALIGN_NAMES,
  alphaOf,
  sizesOf,
  textValue
} from "./styles.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const MIXED = Symbol("mixed");
const PHONE = window.matchMedia("(max-width: 680px)");
const EDGE_GAP = 8;

// Small line drawings for the alignment buttons.
const ICONS = {
  left: "M4 6h16M4 10h10M4 14h16M4 18h10",
  center: "M4 6h16M7 10h10M4 14h16M7 18h10",
  right: "M4 6h16M10 10h10M4 14h16M10 18h10",
  top: "M4 4h16M12 20V9M8 13l4-4 4 4",
  middle: "M4 12h16M12 3v6M9 6l3 3 3-3M12 21v-6M9 18l3-3 3 3",
  bottom: "M4 20h16M12 4v11M8 11l4 4 4-4"
};

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

function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  const path = document.createElementNS(SVG_NS, "path");

  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "prop-icon");
  svg.setAttribute("aria-hidden", "true");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

// The value every item has, or MIXED.
function shared(items, read) {
  const first = read(items[0]);
  return items.every((item) => read(item) === first) ? first : MIXED;
}

// A button that is on when the value is, one of a group (a choice of values).
function choice({ label, options, read, pick }) {
  const group = el("div", "prop-seg");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", label);

  const buttons = options.map(({ value, name, content, className }) => {
    const button = el("button", className ? `prop-button ${className}` : "prop-button");

    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-label", name);
    button.title = name;
    button.dataset.value = String(value);

    if (typeof content === "string") {
      button.textContent = content;
    } else {
      button.append(content);
    }

    button.addEventListener("click", () => pick(value));
    return button;
  });

  group.append(...buttons);

  return {
    element: group,
    sync(items) {
      const value = shared(items, read);

      for (const button of buttons) {
        button.setAttribute("aria-checked", String(value !== MIXED && String(value) === button.dataset.value));
      }
    }
  };
}

// An on/off button (bold, italic).
function toggle({ label, text, className, read, pick }) {
  const button = el("button", `prop-button prop-toggle ${className}`, text);

  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () => pick(button.getAttribute("aria-pressed") !== "true"));

  return {
    element: button,
    sync(items) {
      const value = shared(items, read);
      button.setAttribute("aria-pressed", value === MIXED ? "mixed" : String(value));
    }
  };
}

// Paints a swatch with one colour of a palette: "tone" colours are card fills,
// "ink" colours are for text and lines. null is the theme's own.
function paint(swatch, palette, key) {
  const colour = key ? `var(--${palette}-${key})` : (palette === "tone" ? "var(--card-bg)" : "var(--text)");
  swatch.style.setProperty("--swatch", colour);
}

// The grid of 16 colours, one at a time, next to the button that opened it.
class ColorGrid {
  constructor() {
    this.element = el("div", "color-grid");
    this.element.hidden = true;
    this.element.setAttribute("role", "radiogroup");
    this.anchor = null;
    document.body.append(this.element);

    document.addEventListener("pointerdown", (event) => {
      if (this.isOpen && !this.element.contains(event.target) && !this.anchor?.contains(event.target)) {
        this.close();
      }
    }, true);

    this.element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.close({ focusAnchor: true });
      }
    });

    this.element.addEventListener("pointerdown", (event) => event.preventDefault());
    this.element.addEventListener("mousedown", (event) => event.preventDefault());
    window.addEventListener("resize", () => this.close());
    window.addEventListener("blur", () => this.close());
  }

  get isOpen() {
    return !this.element.hidden;
  }

  // value: the colour key now (null: default), or MIXED; pick(key) chooses one.
  open(anchor, { label, palette, value, pick }, { focus }) {
    this.anchor = anchor;
    anchor.setAttribute("aria-expanded", "true");
    this.element.setAttribute("aria-label", label);

    const swatches = [null, ...COLOR_KEYS].map((key) => {
      const button = el("button", "swatch-button");
      const name = key ? COLOR_NAMES[key] : "Default";

      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-label", name);
      button.setAttribute("aria-checked", String(value !== MIXED && value === key));
      button.title = name;
      paint(button, palette, key);
      button.addEventListener("click", () => {
        this.close({ focusAnchor: focus });
        pick(key);
      });
      return button;
    });

    this.element.replaceChildren(...swatches);
    this.element.hidden = false;
    this.place(anchor);

    if (focus) {
      (swatches.find((button) => button.getAttribute("aria-checked") === "true") ?? swatches[0]).focus({ preventScroll: true });
    }
  }

  // Beside the button on a desktop; above it on a phone, where the strip is
  // along the bottom edge.
  place(anchor) {
    const { width, height } = this.element.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    let left = PHONE.matches ? rect.left : rect.right + EDGE_GAP;
    let top = PHONE.matches ? rect.top - height - EDGE_GAP : rect.top;

    if (!PHONE.matches && left + width > window.innerWidth - EDGE_GAP) {
      left = rect.left - width - EDGE_GAP;
    }

    left = Math.max(EDGE_GAP, Math.min(left, window.innerWidth - width - EDGE_GAP));
    top = Math.max(EDGE_GAP, Math.min(top, window.innerHeight - height - EDGE_GAP));
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
  }

  close({ focusAnchor = false } = {}) {
    if (!this.isOpen) {
      return;
    }

    this.element.hidden = true;
    this.element.replaceChildren();
    this.anchor?.setAttribute("aria-expanded", "false");

    if (focusAnchor) {
      this.anchor?.focus({ preventScroll: true });
    }

    this.anchor = null;
  }
}

export class PropertyBar {
  // element: the (hidden) container; onChange({ kind, set, prop, value }) gets
  // each choice: kind is "fill" (the colour), "alpha", "text" (a property of
  // one piece of text) or "shape" (a line's type).
  constructor(element, onChange) {
    this.element = element;
    this.onChange = onChange;
    this.grid = new ColorGrid();
    this.type = null;
    this.controls = [];

    // Using the bar must not take focus from a field being edited, or
    // editing would end.
    const keepFocus = (event) => {
      if (event.target instanceof Element && event.target.closest("button")) {
        event.preventDefault();
      }
    };

    element.addEventListener("pointerdown", keepFocus);
    element.addEventListener("mousedown", keepFocus);
  }

  // Shows the bar for these selected items, if they are all of one kind.
  show(items) {
    const type = items.length && items.every((item) => item.type === items[0].type) ? items[0].type : null;

    if (!type || !OBJECT_STYLES[type]) {
      this.hide();
      return;
    }

    this.grid.close();

    if (type !== this.type) {
      this.build(type);
    }

    this.element.hidden = false;
    this.element.parentElement?.classList.add("has-properties");

    for (const control of this.controls) {
      control.sync(items);
    }
  }

  hide() {
    this.grid.close();
    this.element.hidden = true;
    this.element.parentElement?.classList.remove("has-properties");
    this.type = null;
    this.controls = [];
    this.element.replaceChildren();
  }

  colour({ label, palette, read, pick }) {
    const button = el("button", "prop-colour");
    const swatch = el("span", "swatch");
    let value = null;

    button.type = "button";
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-expanded", "false");
    button.append(swatch, el("span", "prop-colour-label", label));
    button.addEventListener("click", (event) => {
      if (this.grid.anchor === button) {
        this.grid.close();
      } else {
        this.grid.close();
        // Opened with the keyboard (no pointer): move into the grid.
        this.grid.open(button, { label, palette, value, pick }, { focus: event.detail === 0 });
      }
    });

    return {
      element: button,
      sync(items) {
        value = shared(items, read);
        swatch.classList.toggle("is-mixed", value === MIXED);

        if (value !== MIXED) {
          paint(swatch, palette, value);
        }

        const name = value === MIXED ? "mixed" : (value ? COLOR_NAMES[value] : "default");
        button.title = `${label}: ${name}`;
        button.setAttribute("aria-label", `${label}: ${name}`);
      }
    };
  }

  // The controls for one piece of text, in rows.
  textRows(set) {
    const send = (prop) => (value) => this.onChange({ kind: "text", set: set.key, prop, value });
    const read = (prop) => (item) => textValue(item, set.key, prop);
    const has = (prop) => set.props.includes(prop);
    const rows = [];

    if (has("color")) {
      rows.push([this.colour({ label: "Text colour", palette: "ink", read: read("color"), pick: send("color") })]);
    }

    if (has("font")) {
      rows.push([choice({
        label: `${set.label} font`,
        options: Object.entries(FONT_NAMES).map(([value, name]) => ({ value, name, content: name, className: `prop-font-${value}` })),
        read: read("font"),
        pick: send("font")
      })]);
    }

    if (has("size")) {
      rows.push([choice({
        label: `${set.label} size`,
        options: sizesOf(set).map((value) => ({ value, name: SIZE_NAMES[value], content: value.toUpperCase() })),
        read: read("size"),
        pick: send("size")
      })]);
    }

    const style = [];

    for (const [prop, text, label, className] of [["bold", "B", "Bold", "prop-bold"], ["italic", "I", "Italic", "prop-italic"]]) {
      if (has(prop)) {
        style.push(toggle({ label: `${set.label} ${label.toLowerCase()}`, text, className, read: read(prop), pick: send(prop) }));
      }
    }

    if (has("align")) {
      style.push(choice({
        label: `${set.label} alignment`,
        options: Object.entries(ALIGN_NAMES).map(([value, name]) => ({ value, name, content: icon(value) })),
        read: read("align"),
        pick: send("align")
      }));
    }

    if (style.length) {
      rows.push(style);
    }

    if (has("valign")) {
      rows.push([choice({
        label: `${set.label} vertical alignment`,
        options: Object.entries(VALIGN_NAMES).map(([value, name]) => ({ value, name, content: icon(value) })),
        read: read("valign"),
        pick: send("valign")
      })]);
    }

    return rows;
  }

  build(type) {
    const spec = OBJECT_STYLES[type];
    const groups = [];
    const top = [];

    this.type = type;
    this.controls = [];

    if (spec.fill) {
      top.push([this.colour({
        label: spec.fill,
        palette: spec.palette,
        read: (item) => item.color ?? null,
        pick: (value) => this.onChange({ kind: "fill", value })
      })]);
    }

    if (spec.alpha) {
      top.push([choice({
        label: spec.alpha,
        options: ALPHAS.map((value) => ({ value, name: `${value}%`, content: `${value}%` })),
        read: alphaOf,
        pick: (value) => this.onChange({ kind: "alpha", value })
      })]);
    }

    if (spec.shape) {
      top.push([choice({
        label: "Line type",
        options: [
          { value: "straight", name: "Straight", content: "Straight" },
          { value: "elbow", name: "Right angle", content: "Right angle" }
        ],
        read: (item) => item.data.shape ?? "straight",
        pick: (value) => this.onChange({ kind: "shape", value })
      })]);
    }

    groups.push({ title: spec.heading, rows: top, opacityLabel: spec.alpha });

    for (const set of spec.sets) {
      groups.push({ title: set.label, rows: this.textRows(set) });
    }

    const nodes = groups.map(({ title, rows, opacityLabel }) => {
      const group = el("section", "prop-group");
      group.setAttribute("aria-label", title);
      group.append(el("h2", "prop-heading", title));

      for (const row of rows) {
        const line = el("div", "prop-row");

        // "100% 75% 50% 25%" needs a word to say what it is.
        if (opacityLabel && row[0].element.getAttribute("aria-label") === opacityLabel) {
          line.append(el("span", "prop-label", opacityLabel));
        }

        for (const control of row) {
          line.append(control.element);
          this.controls.push(control);
        }

        group.append(line);
      }

      return group;
    });

    this.element.replaceChildren(...nodes);
  }
}
