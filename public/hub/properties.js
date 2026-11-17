// The property column (docs/hub-spec.md, section 6): a narrow column attached
// to the toolbar (a strip above the toolbar on phones), shown while one or more
// objects of the same kind are selected, with the properties that kind offers
// (styles.js): fill, opacity, and the style of each piece of text.
//
// Each property is one small button that shows what is selected now (a square
// of the colour, "Aa" in the font, "M" for the size...), or a dash when the
// selected objects differ. Resting the mouse on it, or clicking or tapping it,
// opens a menu beside it with the choices for that one property; a colour
// opens a grid of the 16 colours. One menu component serves every property, so
// it is shared by all kinds of object. On/off properties (bold, italic...) are
// plain buttons. Choices go to onChange({ kind, set, prop, value }); the board
// applies them. Everything is built with createElement; nothing is rendered
// from data as HTML.

import {
  ALIGN_NAMES,
  ALPHAS,
  COLOR_KEYS,
  COLOR_NAMES,
  FONT_NAMES,
  LIST_NAMES,
  OBJECT_STYLES,
  SIZE_NAMES,
  VALIGN_NAMES,
  alphaOf,
  extraValue,
  extrasOf,
  isList,
  sizesOf,
  textValue
} from "./styles.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const MIXED = Symbol("mixed");
const PHONE = window.matchMedia("(max-width: 680px)");
const EDGE_GAP = 8;
const MENU_GAP = 4;
const GRID_COLUMNS = 4;
// A mouse opens a menu once it has rested on a button for a moment (so moving
// across the column doesn't flash menus) and closes it a moment after leaving
// (so it can cross the gap into the menu).
const HOVER_OPEN_MS = 150;
const HOVER_CLOSE_MS = 250;

// Small line drawings for the buttons that have no words. The thickness and
// dash drawings are one line each, styled by their class (hub.css).
const ICONS = {
  left: "M4 6h16M4 10h10M4 14h16M4 18h10",
  center: "M4 6h16M7 10h10M4 14h16M7 18h10",
  right: "M4 6h16M10 10h10M4 14h16M10 18h10",
  top: "M4 4h16M12 20V9M8 13l4-4 4 4",
  middle: "M4 12h16M12 3v6M9 6l3 3 3-3M12 21v-6M9 18l3-3 3 3",
  bottom: "M4 20h16M12 4v11M8 11l4 4 4-4",
  flipX: "M12 3v18M8 7l-5 5 5 5zM16 7l5 5-5 5z",
  flipY: "M3 12h18M7 8l5-5 5 5zM7 16l5 5 5-5z",
  "arrow-none": "M4 12h16",
  "arrow-end": "M4 12h16M15 7l5 5-5 5",
  "arrow-start": "M20 12H4M9 7l-5 5 5 5",
  "arrow-both": "M4 12h16M15 7l5 5-5 5M9 7l-5 5 5 5",
  "list-none": "M4 7h16M4 12h16M4 17h10",
  "shape-straight": "M4 18L20 6",
  "shape-elbow": "M4 18h8V6h8",
  "thickness-thin": "M3 12h18",
  "thickness-medium": "M3 12h18",
  "thickness-thick": "M3 12h18",
  "dash-solid": "M3 12h18",
  "dash-dashed": "M3 12h18",
  "dash-dotted": "M3 12h18",
  "corners-square": "M5 20V5h15",
  "corners-rounded": "M5 20v-9a6 6 0 0 1 6-6h9"
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
  svg.setAttribute("class", `prop-icon prop-icon-${name}`);
  svg.setAttribute("aria-hidden", "true");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

// A few letters in the button or menu ("Aa" in a font, "M" for a size).
function glyph(text, className) {
  return el("span", className ? `prop-glyph ${className}` : "prop-glyph", text);
}

// A square of colour: `colour` is any CSS colour (here a palette variable).
function swatch(colour) {
  const node = el("span", "swatch");
  node.style.setProperty("--swatch", colour);
  return node;
}

// The value every item has, or MIXED.
function shared(items, read) {
  const first = read(items[0]);
  return items.every((item) => read(item) === first) ? first : MIXED;
}

// How each kind of list looks on its button and in its menu.
const LIST_FACES = {
  none: () => icon("list-none"),
  bullet: () => glyph("•"),
  number: () => glyph("1."),
  alpha: () => glyph("a.")
};

// The 16 colours of a palette as menu choices: "tone" colours are card fills,
// "ink" colours are for text and lines. null is the theme's own.
const COLOUR_OPTIONS = {};

function colourOptions(palette) {
  COLOUR_OPTIONS[palette] ??= [null, ...COLOR_KEYS].map((key) => ({
    value: key,
    name: key ? COLOR_NAMES[key] : "Default",
    swatch: key ? `var(--${palette}-${key})` : (palette === "tone" ? "var(--card-bg)" : "var(--text)")
  }));

  return COLOUR_OPTIONS[palette];
}

// What a choice looks like on its button: its colour, its drawing or glyph, or
// else its name.
function faceOf(option) {
  if (option.swatch) {
    return swatch(option.swatch);
  }

  const content = option.content?.();
  return content ?? el("span", "prop-face-text", option.name);
}

// The menu that opens beside a property button. One instance serves every
// button in the column: it lists the choices of the button that opened it,
// marks the current one, and sends the pick back.
class OptionMenu {
  // panel: the column the menu opens beside.
  constructor(panel) {
    this.panel = panel;
    this.element = el("div", "prop-menu-popup");
    this.element.hidden = true;
    this.element.setAttribute("role", "menu");
    this.anchor = null;
    // Pinned (clicked, tapped or opened with the keyboard): stays until a
    // choice is made or something else is pressed, however the mouse moves.
    this.pinned = false;
    this.fromKeyboard = false;
    this.openTimer = 0;
    this.closeTimer = 0;
    document.body.append(this.element);

    document.addEventListener("pointerdown", (event) => {
      if (this.isOpen && !this.element.contains(event.target) && !this.anchor?.contains(event.target)) {
        this.close();
      }
    }, true);

    // Using the menu must not take focus from a field being edited, or
    // editing would end.
    this.element.addEventListener("pointerdown", (event) => event.preventDefault());
    this.element.addEventListener("mousedown", (event) => event.preventDefault());

    this.element.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "mouse") {
        clearTimeout(this.closeTimer);
      }
    });

    this.element.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse") {
        this.closeSoon();
      }
    });

    this.element.addEventListener("keydown", (event) => this.onKeyDown(event));

    // Escape closes an open menu first (even one opened with the mouse, where
    // focus never moved into it); the next Escape is the board's.
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.isOpen && !this.element.contains(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
    }, true);

    // Tabbing out of the menu closes it.
    this.element.addEventListener("focusout", (event) => {
      if (this.isOpen && !this.element.contains(event.relatedTarget) && event.relatedTarget !== this.anchor) {
        this.close();
      }
    });

    window.addEventListener("resize", () => this.close());
    window.addEventListener("blur", () => this.close());
  }

  get isOpen() {
    return !this.element.hidden;
  }

  get choices() {
    return [...this.element.querySelectorAll("[role='menuitemradio']")];
  }

  // Makes `button` open the menu (spec() gives its { label, options, value,
  // layout, pick } as they are at that moment).
  bind(button, spec) {
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");

    button.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse") {
        return;
      }

      this.cancelTimers();

      if (this.anchor !== button) {
        // Moving from one button to the next swaps menus at once.
        this.openTimer = setTimeout(() => this.open(button, spec()), this.isOpen ? 0 : HOVER_OPEN_MS);
      }
    });

    button.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse") {
        clearTimeout(this.openTimer);
        this.closeSoon();
      }
    });

    button.addEventListener("click", (event) => {
      // Enter or Space on a focused button (no pointer): move into the menu.
      const keyboard = event.detail === 0;

      this.cancelTimers();

      if (this.anchor !== button) {
        this.open(button, spec(), { pinned: true, keyboard });
      } else if (this.pinned) {
        this.close();
      } else {
        // Opened by resting the mouse on it: a click keeps it open.
        this.pinned = true;
        this.fromKeyboard = keyboard;

        if (keyboard) {
          this.focusChoice();
        }
      }
    });

    button.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        this.cancelTimers();
        this.open(button, spec(), { pinned: true, keyboard: true });
      } else if (event.key === "Escape" && this.anchor === button) {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
    });
  }

  cancelTimers() {
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
  }

  closeSoon() {
    clearTimeout(this.closeTimer);

    if (this.isOpen && !this.pinned) {
      this.closeTimer = setTimeout(() => this.close(), HOVER_CLOSE_MS);
    }
  }

  // value: the current choice (or MIXED); pick(value) chooses one. layout is
  // "grid" (colours) or "list" (a row per choice, with its name).
  open(anchor, { label, options, value, layout, pick }, { pinned = false, keyboard = false } = {}) {
    this.close();
    this.cancelTimers();
    this.anchor = anchor;
    this.pinned = pinned;
    this.fromKeyboard = keyboard;
    anchor.setAttribute("aria-expanded", "true");
    this.element.setAttribute("aria-label", label);
    this.element.classList.toggle("is-grid", layout === "grid");

    const title = el("div", "prop-menu-title", label);
    title.setAttribute("aria-hidden", "true");

    const choices = options.map((option) => {
      const button = el("button", layout === "grid" ? "swatch-button" : "prop-option");

      button.type = "button";
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-label", option.name);
      button.setAttribute("aria-checked", String(value !== MIXED && value === option.value));
      button.title = option.name;

      if (layout === "grid") {
        button.style.setProperty("--swatch", option.swatch);
      } else {
        const content = option.content?.();

        if (content) {
          const face = el("span", "prop-option-face");
          face.append(content);
          button.append(face);
        }

        button.append(el("span", "prop-option-name", option.name));
      }

      button.addEventListener("click", () => {
        const refocus = this.fromKeyboard;
        this.close({ focusAnchor: refocus });
        pick(option.value);
      });

      return button;
    });

    this.element.replaceChildren(title, ...choices);
    this.element.hidden = false;
    this.place();

    if (keyboard) {
      this.focusChoice();
    }
  }

  focusChoice() {
    const choices = this.choices;
    (choices.find((button) => button.getAttribute("aria-checked") === "true") ?? choices[0])?.focus({ preventScroll: true });
  }

  // Beside the column on a desktop, level with the button; above the button on
  // a phone, where the strip is along the bottom edge.
  place() {
    const { width, height } = this.element.getBoundingClientRect();
    const rect = this.anchor.getBoundingClientRect();
    let left;
    let top;

    if (PHONE.matches) {
      left = rect.left;
      top = rect.top - height - EDGE_GAP;
    } else {
      left = this.panel.getBoundingClientRect().right + MENU_GAP;
      top = rect.top;
    }

    left = Math.max(EDGE_GAP, Math.min(left, window.innerWidth - width - EDGE_GAP));
    top = Math.max(EDGE_GAP, Math.min(top, window.innerHeight - height - EDGE_GAP));
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
  }

  // Arrow keys move between the choices; Escape or Tab leave the menu.
  onKeyDown(event) {
    const choices = this.choices;
    const index = choices.indexOf(document.activeElement);
    const grid = this.element.classList.contains("is-grid");
    const down = grid ? GRID_COLUMNS : 1;
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -down, ArrowDown: down };

    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      this.close({ focusAnchor: true });
    } else if (event.key in steps && index >= 0) {
      event.preventDefault();
      event.stopPropagation();
      choices[Math.max(0, Math.min(index + steps[event.key], choices.length - 1))].focus({ preventScroll: true });
    } else if ((event.key === "Home" || event.key === "End") && choices.length) {
      event.preventDefault();
      event.stopPropagation();
      choices[event.key === "Home" ? 0 : choices.length - 1].focus({ preventScroll: true });
    }
  }

  close({ focusAnchor = false } = {}) {
    this.cancelTimers();

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
    this.pinned = false;
    this.fromKeyboard = false;
  }
}

// An on/off button (bold, italic...): its text, or an icon in `content`.
function toggle({ label, text, content, className = "", read, pick }) {
  const button = el("button", `prop-toggle ${className}`, text);

  if (content) {
    button.append(content);
  }

  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () => pick(button.getAttribute("aria-pressed") !== "true"));

  return {
    element: button,
    kind: "toggle",
    sync(items) {
      const value = shared(items, read);
      button.setAttribute("aria-pressed", value === MIXED ? "mixed" : String(value));
    }
  };
}

export class PropertyBar {
  // element: the (hidden) container; onChange({ kind, set, prop, value }) gets
  // each choice: kind is "fill" (the colour), "alpha", "text" (a property of
  // one piece of text), "extra" (one of an object's own properties) or
  // "shape" (a line's type).
  constructor(element, onChange) {
    this.element = element;
    this.onChange = onChange;
    this.menu = new OptionMenu(element);
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

    this.menu.close();

    if (type !== this.type) {
      this.build(type);
    }

    this.element.hidden = false;
    this.element.parentElement?.classList.add("has-properties");

    for (const control of this.controls) {
      control.sync(items);

      // A control can be hidden while it would have no effect (a border colour
      // with no border).
      if (control.when) {
        control.line.hidden = !items.some(control.when);
      }
    }
  }

  hide() {
    this.menu.close();
    this.element.hidden = true;
    this.element.parentElement?.classList.remove("has-properties");
    this.type = null;
    this.controls = [];
    this.element.replaceChildren();
  }

  // A button showing the current choice of one property, and opening the menu
  // of choices. options: [{ value, name, content?, swatch? }] where `content`
  // makes the drawing or glyph for the button and the menu (else the name is
  // shown) and `swatch` is a colour. The layout is a grid for colours.
  choose({ label, options, read, pick, layout = "list" }) {
    const button = el("button", "prop-choice");
    const face = el("span", "prop-face");
    let value = null;

    button.type = "button";
    button.append(face);
    this.menu.bind(button, () => ({ label, options, value, layout, pick }));

    return {
      element: button,
      kind: "choice",
      sync(items) {
        value = shared(items, read);

        const option = value === MIXED ? null : options.find((candidate) => candidate.value === value);
        const name = option ? option.name : "mixed";

        if (option) {
          face.replaceChildren(faceOf(option));
        } else if (layout === "grid") {
          face.replaceChildren(el("span", "swatch is-mixed"));
        } else {
          face.replaceChildren(el("span", "prop-face-text", "–"));
        }

        button.title = `${label}: ${name}`;
        button.setAttribute("aria-label", `${label}: ${name}`);
      }
    };
  }

  colour({ label, palette, read, pick }) {
    return this.choose({ label, options: colourOptions(palette), read, pick, layout: "grid" });
  }

  // The controls for one piece of text, in rows.
  textRows(set) {
    const send = (prop) => (value) => this.onChange({ kind: "text", set: set.key, prop, value });
    const read = (prop) => (item) => textValue(item, set.key, prop);
    const has = (prop) => set.props.includes(prop);
    const rows = [];

    if (has("color")) {
      rows.push([this.colour({ label: `${set.label} colour`, palette: "ink", read: read("color"), pick: send("color") })]);
    }

    if (has("font")) {
      rows.push([this.choose({
        label: `${set.label} font`,
        options: Object.entries(FONT_NAMES).map(([value, name]) => ({
          value,
          name,
          content: () => glyph("Aa", `prop-font-${value}`)
        })),
        read: read("font"),
        pick: send("font")
      })]);
    }

    if (has("size")) {
      rows.push([this.choose({
        label: `${set.label} size`,
        options: sizesOf(set).map((value) => ({ value, name: SIZE_NAMES[value], content: () => glyph(value.toUpperCase()) })),
        read: read("size"),
        pick: send("size")
      })]);
    }

    const style = [];

    const toggles = [
      ["bold", "B", `${set.label} bold`, "prop-bold"],
      ["italic", "I", `${set.label} italic`, "prop-italic"],
      ["strike", "S", "Strike through ticked items", "prop-strike"]
    ];

    for (const [prop, text, label, className] of toggles) {
      if (has(prop)) {
        style.push(toggle({ label, text, className, read: read(prop), pick: send(prop) }));
      }
    }

    if (style.length) {
      rows.push(style);
    }

    if (has("list")) {
      rows.push([this.choose({
        label: `${set.label} list`,
        options: Object.entries(LIST_NAMES).map(([value, name]) => ({ value, name, content: LIST_FACES[value] })),
        read: read("list"),
        pick: send("list")
      })]);
    }

    if (has("align")) {
      const align = this.choose({
        label: `${set.label} alignment`,
        options: Object.entries(ALIGN_NAMES).map(([value, name]) => ({ value, name, content: () => icon(value) })),
        read: read("align"),
        pick: send("align")
      });

      // A list is always left-aligned, so alignment is offered only while some
      // of the selected texts aren't one (their own alignment is kept for when
      // the list goes).
      if (has("list")) {
        align.when = (item) => !isList(item, set.key);
      }

      rows.push([align]);
    }

    if (has("valign")) {
      rows.push([this.choose({
        label: `${set.label} vertical alignment`,
        options: Object.entries(VALIGN_NAMES).map(([value, name]) => ({ value, name, content: () => icon(value) })),
        read: read("valign"),
        pick: send("valign")
      })]);
    }

    if (has("address")) {
      rows.push([toggle({ label: "Show address line", text: "Address", read: read("address"), pick: send("address") })]);
    }

    return rows;
  }

  // The control for one of an object's own extras (a border, a flip, a
  // line's thickness...), sending { kind: "extra", prop, value }.
  extra(extra) {
    const read = (item) => extraValue(item, extra.key);
    const pick = (value) => this.onChange({ kind: "extra", prop: extra.key, value });
    let control;

    if (extra.kind === "color") {
      control = this.colour({ label: extra.label, palette: extra.palette, read, pick });
    } else if (extra.kind === "toggle") {
      control = toggle({ label: extra.label, content: icon(extra.icon), read, pick });
    } else {
      control = this.choose({
        label: extra.label,
        options: Object.entries(extra.options).map(([value, name]) => ({
          value,
          name,
          content: extra.icons ? () => icon(`${extra.key}-${value}`) : undefined
        })),
        read,
        pick
      });
    }

    control.when = extra.when;
    return control;
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
      top.push([this.choose({
        label: spec.alpha,
        options: ALPHAS.map((value) => ({ value, name: `${value}%` })),
        read: alphaOf,
        pick: (value) => this.onChange({ kind: "alpha", value })
      })]);
    }

    if (spec.shape) {
      top.push([this.choose({
        label: "Line type",
        options: [
          { value: "straight", name: "Straight", content: () => icon("shape-straight") },
          { value: "elbow", name: "Right angle", content: () => icon("shape-elbow") }
        ],
        read: (item) => item.data.shape ?? "straight",
        pick: (value) => this.onChange({ kind: "shape", value })
      })]);
    }

    groups.push({ title: spec.heading, rows: top });

    // The object's own extras: in the top group when they name it, otherwise in
    // groups of their own after it. Extras with the same `row` share a line.
    const placed = new Map();

    for (const extra of extrasOf(type)) {
      const rowKey = `${extra.group}/${extra.row ?? extra.key}`;
      let row = placed.get(rowKey);

      if (!row) {
        row = [];
        placed.set(rowKey, row);

        let group = groups.find((candidate) => candidate.title === extra.group);

        if (!group) {
          group = { title: extra.group, rows: [] };
          groups.push(group);
        }

        group.rows.push(row);
      }

      row.push(this.extra(extra));
    }

    for (const set of spec.sets) {
      groups.push({ title: set.label, rows: this.textRows(set) });
    }

    const nodes = groups.map(({ title, rows }) => {
      const group = el("section", "prop-group");
      group.setAttribute("aria-label", title);
      group.append(el("h2", "prop-heading", title));

      for (const row of rows) {
        // On/off buttons sit side by side; a menu button has the row to itself.
        const line = el("div", row.some((control) => control.kind === "toggle") ? "prop-row prop-toggles" : "prop-row");

        for (const control of row) {
          line.append(control.element);
          control.line = line;
          this.controls.push(control);
        }

        group.append(line);
      }

      return group;
    });

    this.element.replaceChildren(...nodes);
  }
}
