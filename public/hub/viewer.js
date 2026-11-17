// The image viewer (docs/hub-spec.md, section 6 "Image viewer"): an image at
// full size over a dark screen. It opens fitted to the screen (never larger
// than 100%); the wheel, a pinch, the buttons or + and - zoom (around the
// pointer), dragging pans, a double-click switches between fitted and 100%.
// Left and right (arrows, buttons, or a swipe at fitted size) go through the
// board's images. Esc or the close button closes it. A native modal <dialog>.

import { fileUrl } from "./api.js";
import { el } from "./dialog.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
const STEP = 1.25;
const PADDING = 32;
const SWIPE_DISTANCE = 60;

const ICONS = {
  previous: "M15 5l-7 7 7 7",
  next: "M9 5l7 7-7 7",
  out: "M6 12h12",
  in: "M6 12h12M12 6v12",
  fit: "M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4",
  open: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  close: "M6 6l12 12M18 6L6 18"
};

function svgIcon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  const path = document.createElementNS(SVG_NS, "path");

  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

function iconButton(label, name, onClick) {
  const button = el("button", "viewer-button");

  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(svgIcon(name));
  button.addEventListener("click", onClick);
  return button;
}

const clampScale = (scale) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

// images: [{ fileId, caption }], in board order; opens at `start`.
export function openImageViewer(images, start = 0) {
  if (!images.length) {
    return;
  }

  const dialog = el("dialog", "viewer");
  const stage = el("div", "viewer-stage");
  const image = el("img", "viewer-image");
  const top = el("div", "viewer-bar viewer-top");
  const bottom = el("div", "viewer-bar viewer-bottom");
  const caption = el("p", "viewer-caption");
  const count = el("span", "viewer-count");
  const level = el("button", "viewer-level", "100%");
  const original = el("a", "viewer-button");

  const state = { index: start, scale: 1, fitScale: 1, x: 0, y: 0, width: 0, height: 0 };
  const pointers = new Map();
  let gesture = null;

  dialog.setAttribute("aria-label", "Image viewer");
  image.alt = "";
  image.draggable = false;
  level.type = "button";
  level.title = "Switch between fitted and 100%";
  original.target = "_blank";
  original.rel = "noopener noreferrer";
  original.title = "Open the original in a new tab";
  original.setAttribute("aria-label", "Open the original in a new tab");
  original.append(svgIcon("open"));

  const previous = iconButton("Previous image (←)", "previous", () => go(-1));
  const next = iconButton("Next image (→)", "next", () => go(1));

  top.append(
    count,
    caption,
    original,
    iconButton("Close (Esc)", "close", () => dialog.close())
  );
  bottom.append(
    previous,
    iconButton("Zoom out (−)", "out", () => zoomBy(1 / STEP)),
    level,
    iconButton("Zoom in (+)", "in", () => zoomBy(STEP)),
    iconButton("Fit to screen (F)", "fit", () => fit()),
    next
  );
  stage.append(image);
  dialog.append(stage, top, bottom);
  document.body.append(dialog);

  function size() {
    return { width: stage.clientWidth, height: stage.clientHeight };
  }

  function apply() {
    image.style.transform = `translate(-50%, -50%) translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    level.textContent = `${Math.round(state.scale * 100)}%`;
    level.setAttribute("aria-label", `Zoom ${Math.round(state.scale * 100)}%, switch between fitted and 100%`);
    stage.classList.toggle("is-zoomed", state.scale > state.fitScale + 0.001);
  }

  function fit() {
    const { width, height } = size();

    if (!state.width || !state.height) {
      return;
    }

    state.fitScale = Math.min(1, (width - PADDING * 2) / state.width, (height - PADDING * 2) / state.height);
    state.scale = Math.max(MIN_SCALE, state.fitScale);
    state.x = 0;
    state.y = 0;
    apply();
  }

  // Zooms keeping the point under `at` (stage pixels from its centre) still.
  function zoomTo(scale, at = { x: 0, y: 0 }) {
    const next = clampScale(scale);
    const ratio = next / state.scale;
    state.x = at.x - (at.x - state.x) * ratio;
    state.y = at.y - (at.y - state.y) * ratio;
    state.scale = next;
    apply();
  }

  function zoomBy(factor, at) {
    zoomTo(state.scale * factor, at);
  }

  function fromCentre(event) {
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  }

  function show(index) {
    state.index = (index + images.length) % images.length;

    const { fileId, caption: text } = images[state.index];

    state.width = 0;
    state.height = 0;
    image.classList.remove("is-ready");
    image.src = fileUrl(fileId);
    image.alt = text || "Image";
    caption.textContent = text;
    count.textContent = images.length > 1 ? `${state.index + 1} of ${images.length}` : "";
    original.href = fileUrl(fileId);
    previous.hidden = images.length < 2;
    next.hidden = images.length < 2;
  }

  function go(step) {
    if (images.length > 1) {
      show(state.index + step);
    }
  }

  image.addEventListener("load", () => {
    state.width = image.naturalWidth;
    state.height = image.naturalHeight;
    image.style.width = `${state.width}px`;
    image.style.height = `${state.height}px`;
    fit();
    image.classList.add("is-ready");
  });

  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomBy(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)), fromCentre(event));
  }, { passive: false });

  stage.addEventListener("dblclick", (event) => {
    if (state.scale > state.fitScale + 0.001) {
      fit();
    } else {
      zoomTo(Math.max(1, state.fitScale * 2), fromCentre(event));
    }
  });

  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.pointerType === "mouse") {
      return;
    }

    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, fromCentre(event));

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { type: "pinch", distance: Math.hypot(a.x - b.x, a.y - b.y), scale: state.scale };
    } else if (pointers.size === 1) {
      const point = fromCentre(event);
      gesture = { type: "pan", start: point, last: point, x: state.x, y: state.y };
    }
  });

  stage.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId) || !gesture) {
      return;
    }

    const point = fromCentre(event);
    pointers.set(event.pointerId, point);

    if (gesture.type === "pinch" && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);

      if (gesture.distance > 0) {
        zoomTo(gesture.scale * (distance / gesture.distance), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      }
    } else if (gesture.type === "pan" && state.scale > state.fitScale + 0.001) {
      state.x = gesture.x + point.x - gesture.start.x;
      state.y = gesture.y + point.y - gesture.start.y;
      apply();
    }

    gesture.last = point;
  });

  const endPointer = (event) => {
    if (!pointers.delete(event.pointerId)) {
      return;
    }

    // At fitted size, a sideways swipe goes to the next or previous image.
    if (gesture?.type === "pan" && !pointers.size && state.scale <= state.fitScale + 0.001) {
      const dx = gesture.last.x - gesture.start.x;

      if (Math.abs(dx) > SWIPE_DISTANCE && Math.abs(dx) > Math.abs(gesture.last.y - gesture.start.y)) {
        go(dx < 0 ? 1 : -1);
      }
    }

    gesture = null;
  };

  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", endPointer);

  level.addEventListener("click", () => {
    if (Math.abs(state.scale - 1) < 0.001) {
      fit();
    } else {
      zoomTo(1);
    }
  });

  dialog.addEventListener("keydown", (event) => {
    const actions = {
      ArrowLeft: () => go(-1),
      ArrowRight: () => go(1),
      "+": () => zoomBy(STEP),
      "=": () => zoomBy(STEP),
      "-": () => zoomBy(1 / STEP),
      _: () => zoomBy(1 / STEP),
      0: () => zoomTo(1),
      f: () => fit(),
      F: () => fit()
    };
    const action = actions[event.key];

    if (action && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      action();
    }
  });

  const onResize = () => {
    const fitted = state.scale <= state.fitScale + 0.001;
    const { width, height } = size();

    if (state.width) {
      state.fitScale = Math.min(1, (width - PADDING * 2) / state.width, (height - PADDING * 2) / state.height);
    }

    if (fitted) {
      fit();
    }
  };

  window.addEventListener("resize", onResize);

  dialog.addEventListener("close", () => {
    window.removeEventListener("resize", onResize);
    dialog.remove();
  });

  show(start);
  dialog.showModal();
  dialog.querySelector(".viewer-top .viewer-button:last-child")?.focus();
}
