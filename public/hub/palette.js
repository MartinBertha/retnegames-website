// Adding cards by dragging them from the toolbar onto the board. While
// dragging, an outline of the new card (at the board's zoom) follows the
// pointer; dropping places the card there. A plain tap only explains this.
// Enter or Space on a focused button (keyboard, screen readers) still adds
// the card in the middle of the view.

import { CARD_TYPES } from "./cards.js";

const DRAG_THRESHOLD = 4;
// A click this soon after a press on the same button came from that press.
const POINTER_CLICK_WINDOW_MS = 1000;

function createGhost(label, size, zoom) {
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  ghost.textContent = label;
  ghost.style.width = `${size.w * zoom}px`;
  ghost.style.height = `${size.h * zoom}px`;
  document.body.append(ghost);
  return ghost;
}

// tools: buttons with data-card-type. onAdd(type, worldPoint | null, options)
// where null means "somewhere in view" and options.free means Shift was held
// (no grid snapping); onHint(label) after a tap without a drag.
export function initPalette({ tools, canvas, view, onAdd, onHint }) {
  let drag = null;

  const overBoard = (event) => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    return Boolean(target && canvas.contains(target) && !target.closest(".canvas-overlay"));
  };

  const end = () => {
    drag?.ghost?.remove();
    document.body.classList.remove("is-placing");
    drag = null;
  };

  for (const tool of tools) {
    const type = tool.dataset.cardType;
    const label = tool.querySelector(".tool-label")?.textContent ?? type;
    let pressedAt = 0;

    tool.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !view.boardId) {
        return;
      }

      event.preventDefault();
      pressedAt = Date.now();
      drag = { tool, type, pointerId: event.pointerId, x: event.clientX, y: event.clientY, ghost: null };

      try {
        tool.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointers can't be captured.
      }
    });

    tool.addEventListener("pointermove", (event) => {
      if (drag?.tool !== tool || event.pointerId !== drag.pointerId) {
        return;
      }

      if (!drag.ghost) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_THRESHOLD) {
          return;
        }

        view.finishEditing();
        drag.ghost = createGhost(label, CARD_TYPES[type], view.viewport.zoom);
        document.body.classList.add("is-placing");
      }

      // Over the board the outline shows exactly where the card will land
      // (snapped to the grid unless Shift is held); elsewhere it follows the pointer.
      const over = overBoard(event);
      const style = drag.ghost.style;

      if (over) {
        const spot = view.placementPreview(type, event);
        style.left = `${spot.left}px`;
        style.top = `${spot.top}px`;
      } else {
        style.left = `${event.clientX - drag.ghost.offsetWidth / 2}px`;
        style.top = `${event.clientY - drag.ghost.offsetHeight / 2}px`;
      }

      drag.ghost.classList.toggle("is-over-board", over);
    });

    tool.addEventListener("pointerup", (event) => {
      if (drag?.tool !== tool || event.pointerId !== drag.pointerId) {
        return;
      }

      const dragged = Boolean(drag.ghost);
      end();

      if (!dragged) {
        onHint(label);
      } else if (overBoard(event)) {
        onAdd(type, view.worldPointAt(event), { free: event.shiftKey });
      }
    });

    tool.addEventListener("pointercancel", end);

    tool.addEventListener("click", () => {
      if (Date.now() - pressedAt > POINTER_CLICK_WINDOW_MS) {
        onAdd(type, null);
      }
    });
  }

  // Escape drops nothing.
  document.addEventListener("keydown", (event) => {
    if (drag && event.key === "Escape") {
      event.preventDefault();
      end();
    }
  }, true);
}
