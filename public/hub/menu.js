// Card menu (docs/hub-spec.md, section 6): right-click, long-press on touch,
// or the Menu key / Shift+F10. Acts on the selected cards.

import { COLORS } from "./cards.js";

const COLOR_NAMES = {
  grey: "Grey",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  purple: "Purple"
};

const NOTE_SIZES = [["s", "Small text"], ["m", "Medium text"], ["l", "Large text"]];
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
const EDGE_GAP = 8;

function button(className, label, { text = label, role = "menuitem", checked } = {}) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = className;
  item.setAttribute("role", role);

  if (text === label) {
    item.textContent = text;
  } else {
    item.setAttribute("aria-label", label);
    item.textContent = text;
  }

  if (checked !== undefined) {
    item.setAttribute("aria-checked", String(checked));
  }

  return item;
}

export class CardMenu {
  constructor(onAction) {
    this.onAction = onAction;
    this.element = document.createElement("div");
    this.element.className = "card-menu";
    this.element.hidden = true;
    this.element.setAttribute("role", "menu");
    this.element.setAttribute("aria-label", "Card actions");
    document.body.append(this.element);

    document.addEventListener("pointerdown", (event) => {
      if (this.isOpen && !this.element.contains(event.target)) {
        this.close();
      }
    }, true);

    this.element.addEventListener("keydown", (event) => this.onKeyDown(event));
    window.addEventListener("resize", () => this.close());
    window.addEventListener("blur", () => this.close());
  }

  get isOpen() {
    return !this.element.hidden;
  }

  // colors: colours of the selected cards; noteSizes: their note sizes (empty if no notes).
  open(x, y, { colors, noteSizes }) {
    const add = (item, action) => {
      item.addEventListener("click", () => {
        this.close();
        this.onAction(action);
      });
      return item;
    };

    const swatches = document.createElement("div");
    swatches.className = "menu-swatches";
    swatches.setAttribute("role", "group");
    swatches.setAttribute("aria-label", "Colour");

    for (const color of [null, ...COLORS]) {
      const swatch = button("menu-swatch", color ? COLOR_NAMES[color] : "Default colour", {
        text: "",
        role: "menuitemradio",
        checked: colors.size === 1 && colors.has(color)
      });
      swatch.dataset.color = color ?? "default";
      swatch.title = color ? COLOR_NAMES[color] : "Default";
      swatches.append(add(swatch, { type: "color", value: color }));
    }

    const children = [swatches];

    if (noteSizes.size) {
      const sizes = document.createElement("div");
      sizes.className = "menu-sizes";
      sizes.setAttribute("role", "group");
      sizes.setAttribute("aria-label", "Text size");

      for (const [size, label] of NOTE_SIZES) {
        const item = button("menu-size", label, {
          text: size.toUpperCase(),
          role: "menuitemradio",
          checked: noteSizes.size === 1 && noteSizes.has(size)
        });
        sizes.append(add(item, { type: "size", value: size }));
      }

      children.push(sizes);
    }

    const duplicate = button("menu-item", "Duplicate");
    const hint = document.createElement("span");
    hint.className = "menu-hint";
    hint.textContent = `${MOD}D`;
    duplicate.append(hint);

    const separator = document.createElement("div");
    separator.className = "menu-separator";
    separator.setAttribute("role", "separator");

    children.push(
      add(duplicate, { type: "duplicate" }),
      add(button("menu-item", "Bring to front"), { type: "front" }),
      add(button("menu-item", "Send to back"), { type: "back" }),
      separator,
      add(button("menu-item menu-danger", "Delete"), { type: "delete" })
    );

    this.element.replaceChildren(...children);
    this.element.hidden = false;

    // Keep the whole menu on screen.
    const { width, height } = this.element.getBoundingClientRect();
    const left = Math.max(EDGE_GAP, Math.min(x, window.innerWidth - width - EDGE_GAP));
    const top = Math.max(EDGE_GAP, Math.min(y, window.innerHeight - height - EDGE_GAP));
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;

    this.element.querySelector(".menu-item")?.focus({ preventScroll: true });
  }

  close() {
    if (this.isOpen) {
      this.element.hidden = true;
      this.element.replaceChildren();
    }
  }

  onKeyDown(event) {
    const items = [...this.element.querySelectorAll("button")];
    const index = items.indexOf(document.activeElement);
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    } else if (step) {
      event.preventDefault();
      event.stopPropagation();
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  }
}
