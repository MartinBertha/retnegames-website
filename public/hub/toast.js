// Short messages at the bottom of the screen (upload progress and errors),
// optionally with one action button (e.g. "Show" after moving cards).

const DEFAULT_TIMEOUT_MS = 4000;

let element = null;
let timer = null;

export function showToast(message, { tone = "info", timeout = DEFAULT_TIMEOUT_MS, action = null } = {}) {
  if (!element) {
    element = document.getElementById("toast");
  }

  clearTimeout(timer);
  element.replaceChildren(document.createTextNode(message));
  element.dataset.tone = tone;
  element.hidden = false;

  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      hideToast();
      action.onClick();
    });
    element.append(" ", button);
  }

  if (timeout) {
    timer = setTimeout(hideToast, timeout);
  }
}

export function hideToast() {
  clearTimeout(timer);

  if (element) {
    element.hidden = true;
  }
}
