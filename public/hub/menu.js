// Card menu (docs/hub-spec.md, section 6): right-click, long-press on touch,
// or the Menu key / Shift+F10. Actions on the selected cards only: how an
// object looks is changed in the property bar (properties.js). On empty canvas
// it only offers Paste.

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
    this.element.tabIndex = -1;
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

  // canPaste: there are copied cards; canvas: the empty-canvas menu.
  open(x, y, { canPaste = false, canvas = false }) {
    const add = (item, action) => {
      item.addEventListener("click", () => {
        this.close();
        this.onAction(action);
      });
      return item;
    };

    const withHint = (label, keys) => {
      const item = button("menu-item", label);
      const hint = document.createElement("span");
      hint.className = "menu-hint";
      hint.textContent = keys;
      item.append(hint);
      return item;
    };

    const paste = add(withHint("Paste", `${MOD}V`), { type: "paste" });
    paste.disabled = !canPaste;

    const separator = () => {
      const line = document.createElement("div");
      line.className = "menu-separator";
      line.setAttribute("role", "separator");
      return line;
    };

    if (canvas) {
      this.show(x, y, [paste]);
      return;
    }

    const children = [];

    children.push(
      add(withHint("Copy", `${MOD}C`), { type: "copy" }),
      add(withHint("Cut", `${MOD}X`), { type: "cut" }),
      paste,
      add(withHint("Duplicate", `${MOD}D`), { type: "duplicate" }),
      separator(),
      add(button("menu-item", "Bring to front"), { type: "front" }),
      add(button("menu-item", "Send to back"), { type: "back" }),
      separator(),
      add(button("menu-item menu-danger", "Delete"), { type: "delete" })
    );

    this.show(x, y, children);
  }

  show(x, y, children) {
    this.element.replaceChildren(...children);
    this.element.hidden = false;

    // Keep the whole menu on screen.
    const { width, height } = this.element.getBoundingClientRect();
    const left = Math.max(EDGE_GAP, Math.min(x, window.innerWidth - width - EDGE_GAP));
    const top = Math.max(EDGE_GAP, Math.min(y, window.innerHeight - height - EDGE_GAP));
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;

    (this.element.querySelector(".menu-item:not(:disabled)") ?? this.element).focus({ preventScroll: true });
  }

  close() {
    if (this.isOpen) {
      this.element.hidden = true;
      this.element.replaceChildren();
    }
  }

  onKeyDown(event) {
    const items = [...this.element.querySelectorAll("button:not(:disabled)")];
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
