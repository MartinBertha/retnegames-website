// Modal dialogs (Recently deleted, Backups): a native <dialog>, so focus stays
// inside and Escape closes it. While one is open the board ignores its keys
// and the clipboard (board.js, app.js). Content is built with textContent.

const SVG_NS = "http://www.w3.org/2000/svg";

let counter = 0;

export function el(tag, className, text) {
  const node = document.createElement(tag);

  if (className) {
    node.className = className;
  }

  if (text !== undefined) {
    node.textContent = text;
  }

  return node;
}

export function isDialogOpen() {
  return Boolean(document.querySelector("dialog[open]"));
}

function closeIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  const path = document.createElementNS(SVG_NS, "path");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  path.setAttribute("d", "M6 6l12 12M18 6L6 18");
  svg.append(path);
  return svg;
}

// Opens a dialog; returns { dialog, body, close }. onClose runs once it's gone.
export function openDialog({ title, intro, onClose }) {
  const dialog = el("dialog", "dialog");
  const panel = el("div", "dialog-panel");
  const head = el("div", "dialog-head");
  const heading = el("h2", "dialog-title", title);
  const close = el("button", "icon-button dialog-close");
  const body = el("div", "dialog-body");

  heading.id = `dialog-title-${++counter}`;
  dialog.setAttribute("aria-labelledby", heading.id);
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.append(closeIcon());
  head.append(heading, close);
  panel.append(head);

  if (intro) {
    panel.append(el("p", "dialog-intro", intro));
  }

  panel.append(body);
  dialog.append(panel);
  document.body.append(dialog);

  close.addEventListener("click", () => dialog.close());

  // A click on the dimmed page around the panel closes it.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });

  dialog.addEventListener("close", () => {
    dialog.remove();
    onClose?.();
  });

  dialog.showModal();
  return { dialog, body, close: () => dialog.close() };
}

// A plain button in a dialog.
export function dialogButton(label, onClick, className = "dialog-button") {
  const button = el("button", className, label);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}
