// Short messages at the bottom of the screen (upload progress and errors).

const DEFAULT_TIMEOUT_MS = 4000;

let element = null;
let timer = null;

export function showToast(message, { tone = "info", timeout = DEFAULT_TIMEOUT_MS } = {}) {
  if (!element) {
    element = document.getElementById("toast");
  }

  clearTimeout(timer);
  element.textContent = message;
  element.dataset.tone = tone;
  element.hidden = false;

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
