// The canvas of the open board: its cards, the selection, and all pointer and
// keyboard interaction (docs/hub-spec.md, section 6).
//
// Mouse: drag empty canvas to pan, Shift-drag for a marquee, Space-drag or the
// middle button pans anywhere, wheel or trackpad pinch zooms. Touch: one finger
// pans (or drags a card), two fingers pinch-zoom and pan. Double-click or
// double-tap edits a card, opens a folder, or adds a note on empty canvas.

import { CARD_TYPES, createCardElement, positionCard, updateCardElement } from "./cards.js";
import { Viewport } from "./viewport.js";

const COORDINATE_LIMIT = 1_000_000;
const MAX_CARD_SIZE = 10_000;
const MAX_NOTE_LENGTH = 20_000;
const MAX_NAME_LENGTH = 100;
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_DISTANCE = 24;
const CASCADE_OFFSET = 24;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const clampCoordinate = (value) => Math.round(clamp(value, -COORDINATE_LIMIT, COORDINATE_LIMIT));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function isTextField(target) {
  return target instanceof Element
    && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function cleanName(value) {
  return value.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
}

function snapshot({ id, type, x, y, w, h, z, color, data }) {
  return { id, type, x, y, w, h, z, color, data };
}

export class BoardView {
  // callbacks: onOps(boardId, ops), onOpenBoard(id), onSelectionChange(count),
  // onViewChange(), onItemsChange(count)
  constructor(canvas, world, callbacks) {
    this.canvas = canvas;
    this.world = world;
    this.callbacks = callbacks;
    this.viewport = new Viewport(canvas, world, () => callbacks.onViewChange?.());
    this.boardId = null;
    this.items = new Map();
    this.elements = new Map();
    this.selected = new Set();
    this.editing = null;
    this.gesture = null;
    this.pointers = new Map();
    this.lastTap = null;
    this.spaceDown = false;
    this.bindEvents();
  }

  bindEvents() {
    const canvas = this.canvas;

    canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.onPointerUp(event, false));
    canvas.addEventListener("pointercancel", (event) => this.onPointerUp(event, true));
    canvas.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });

    // Links in notes open from the tap handler, so a drag never opens one.
    canvas.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest(".card a")) {
        event.preventDefault();
      }
    }, true);

    // No browser menu on cards (long-press on touch); the card menu comes later.
    canvas.addEventListener("contextmenu", (event) => {
      if (event.target instanceof Element && event.target.closest(".card") && !isTextField(event.target)) {
        event.preventDefault();
      }
    });

    // Safari's own pinch would zoom the whole page.
    canvas.addEventListener("gesturestart", (event) => event.preventDefault());

    document.addEventListener("keydown", (event) => this.onKeyDown(event));
    document.addEventListener("keyup", (event) => {
      if (event.key === " ") {
        this.setSpaceDown(false);
      }
    });
    window.addEventListener("blur", () => this.setSpaceDown(false));
  }

  // ---- Board lifecycle -------------------------------------------------

  show(boardId, view, items) {
    this.reset();
    this.boardId = boardId;

    for (const item of items) {
      this.addItem(item);
    }

    this.viewport.setView(view.x, view.y, view.zoom, { silent: true });
    this.renderSelection();
    this.callbacks.onItemsChange?.(this.items.size);
  }

  clear() {
    this.reset();
    this.renderSelection();
  }

  reset() {
    this.finishEditing();
    this.cancelGesture();
    this.pointers.clear();
    this.boardId = null;
    this.items.clear();
    this.elements.clear();
    this.selected.clear();
    this.lastTap = null;
    this.world.replaceChildren();
  }

  isBusy() {
    return Boolean(this.gesture || this.editing);
  }

  // Server copy after a refetch (with unsaved local changes already applied).
  applyRemote(items) {
    const incoming = new Map(items.map((item) => [item.id, item]));
    const editingId = this.editing?.id;

    for (const id of [...this.items.keys()]) {
      if (!incoming.has(id) && id !== editingId) {
        this.removeItem(id);
      }
    }

    for (const item of items) {
      if (item.id === editingId) {
        continue;
      }

      const current = this.items.get(item.id);

      if (current) {
        Object.assign(current, structuredClone(item));
        updateCardElement(this.elements.get(item.id), current);
      } else {
        this.addItem(item);
      }
    }

    this.selected = new Set([...this.selected].filter((id) => this.items.has(id)));
    this.renderSelection();
    this.callbacks.onItemsChange?.(this.items.size);
  }

  // ---- Cards -------------------------------------------------------------

  addItem(item) {
    const copy = structuredClone(item);
    const element = createCardElement(copy);
    this.items.set(copy.id, copy);
    this.elements.set(copy.id, element);
    this.world.append(element);
    return copy;
  }

  removeItem(id) {
    this.elements.get(id)?.remove();
    this.elements.delete(id);
    this.items.delete(id);
    this.selected.delete(id);
  }

  emit(ids) {
    const ops = ids
      .filter((id) => this.items.has(id))
      .map((id) => ({ op: "upsert", item: snapshot(this.items.get(id)) }));

    if (ops.length && this.boardId) {
      this.callbacks.onOps(this.boardId, ops);
    }
  }

  maxZ() {
    let max = 0;

    for (const item of this.items.values()) {
      max = Math.max(max, item.z);
    }

    return max;
  }

  bringToFront(id) {
    const item = this.items.get(id);

    for (const other of this.items.values()) {
      if (other !== item && other.z >= item.z) {
        item.z = this.maxZ() + 1;
        positionCard(this.elements.get(id), item);
        this.emit([id]);
        return;
      }
    }
  }

  // Adds a card centred on a world point, selects it and starts editing it.
  createCard(type, center) {
    if (!this.boardId) {
      return;
    }

    const size = CARD_TYPES[type];
    const data = type === "note"
      ? { text: "", size: "m" }
      : { name: "New folder", childBoardId: crypto.randomUUID() };

    const item = this.addItem({
      id: crypto.randomUUID(),
      type,
      x: clampCoordinate(center.x - size.w / 2),
      y: clampCoordinate(center.y - size.h / 2),
      w: size.w,
      h: size.h,
      z: this.maxZ() + 1,
      color: null,
      data
    });

    this.setSelection([item.id]);
    this.emit([item.id]);
    this.callbacks.onItemsChange?.(this.items.size);

    if (type === "note") {
      this.startNoteEdit(item.id, { fresh: true });
    } else {
      this.startFolderRename(item.id, { selectAll: true });
    }
  }

  // Toolbar buttons: the middle of the view, nudged off cards already there.
  createCardInView(type) {
    const size = CARD_TYPES[type];
    let center = this.viewport.centerWorld();

    for (let step = 0; step < 50; step++) {
      const x = Math.round(center.x - size.w / 2);
      const y = Math.round(center.y - size.h / 2);
      const taken = [...this.items.values()].some((item) => (
        Math.abs(item.x - x) < CASCADE_OFFSET / 2 && Math.abs(item.y - y) < CASCADE_OFFSET / 2
      ));

      if (!taken) {
        break;
      }

      center = { x: center.x + CASCADE_OFFSET, y: center.y + CASCADE_OFFSET };
    }

    this.createCard(type, center);
  }

  deleteSelected() {
    this.finishEditing();

    if (!this.selected.size || !this.boardId) {
      return;
    }

    const ids = [...this.selected];
    const folders = ids.map((id) => this.items.get(id)).filter((item) => item.type === "folder");

    if (folders.length) {
      const question = folders.length === 1
        ? `Delete the folder "${folders[0].data.name}" and everything in it?`
        : `Delete ${folders.length} folders and everything in them?`;

      if (!window.confirm(question)) {
        return;
      }
    }

    for (const id of ids) {
      this.removeItem(id);
    }

    this.renderSelection();
    this.callbacks.onItemsChange?.(this.items.size);
    this.callbacks.onOps(this.boardId, ids.map((id) => ({ op: "delete", id })));
  }

  // ---- Selection -------------------------------------------------------

  setSelection(ids) {
    this.selected = new Set(ids);
    this.renderSelection();
  }

  renderSelection() {
    for (const [id, element] of this.elements) {
      element.classList.toggle("is-selected", this.selected.has(id));
    }

    this.callbacks.onSelectionChange?.(this.selected.size);
  }

  // ---- Editing -----------------------------------------------------------

  startNoteEdit(id, { fresh = false } = {}) {
    this.finishEditing();

    const item = this.items.get(id);
    const card = this.elements.get(id);
    const text = card.querySelector(".note-text");
    const editor = document.createElement("textarea");

    editor.className = "card-editor note-editor";
    editor.value = item.data.text;
    editor.maxLength = MAX_NOTE_LENGTH;
    editor.setAttribute("aria-label", "Note text");

    text.hidden = true;
    card.classList.add("is-editing");
    card.insertBefore(editor, card.querySelector(".resize-handle"));

    this.editing = {
      id,
      editor,
      finish: () => {
        editor.remove();
        text.hidden = false;
        card.classList.remove("is-editing");

        // A new note left empty is discarded.
        if (fresh && !item.data.text.trim()) {
          this.removeItem(id);
          this.renderSelection();
          this.callbacks.onItemsChange?.(this.items.size);
          this.callbacks.onOps(this.boardId, [{ op: "delete", id }]);
        } else {
          updateCardElement(card, item);
        }
      }
    };

    editor.addEventListener("input", () => {
      item.data.text = editor.value;
      this.growToFit(item, card, editor);
      this.emit([id]);
    });

    editor.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.finishEditing();
      }
    });

    editor.addEventListener("blur", () => this.finishEditingOnBlur());

    this.setSelection([id]);
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(editor.value.length, editor.value.length);
    this.growToFit(item, card, editor);
  }

  // Notes grow taller while typing rather than scrolling.
  growToFit(item, card, editor) {
    const overflow = editor.scrollHeight - editor.clientHeight;

    if (overflow > 0) {
      item.h = Math.min(MAX_CARD_SIZE, Math.ceil(item.h + overflow));
      positionCard(card, item);
    }
  }

  startFolderRename(id, { selectAll = false } = {}) {
    this.finishEditing();

    const item = this.items.get(id);
    const card = this.elements.get(id);
    const label = card.querySelector(".folder-name");
    const input = document.createElement("input");
    let cancelled = false;

    input.type = "text";
    input.className = "card-editor folder-name-editor";
    input.value = item.data.name;
    input.maxLength = MAX_NAME_LENGTH;
    input.enterKeyHint = "done";
    input.setAttribute("aria-label", "Folder name");

    label.hidden = true;
    label.after(input);
    card.classList.add("is-editing");

    this.editing = {
      id,
      editor: input,
      finish: () => {
        input.remove();
        label.hidden = false;
        card.classList.remove("is-editing");

        const name = cleanName(input.value);

        if (!cancelled && name && name !== item.data.name) {
          item.data.name = name;
          updateCardElement(card, item);
          this.emit([id]);
        }
      }
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        cancelled = event.key === "Escape";
        this.finishEditing();
      }
    });

    input.addEventListener("blur", () => this.finishEditingOnBlur());

    this.setSelection([id]);
    input.focus({ preventScroll: true });

    if (selectAll) {
      input.select();
    }
  }

  finishEditing() {
    const editing = this.editing;

    if (editing) {
      this.editing = null;
      editing.finish();
    }
  }

  // Switching to another window also blurs the editor; keep editing then,
  // focus comes back to it on return.
  finishEditingOnBlur() {
    if (document.hasFocus()) {
      this.finishEditing();
    }
  }

  // Double-click or double-tap on a card.
  activateCard(id, target) {
    const item = this.items.get(id);

    if (item.type === "note") {
      this.startNoteEdit(id);
    } else if (item.type === "folder") {
      if (target instanceof Element && target.closest(".folder-name")) {
        this.startFolderRename(id);
      } else {
        this.callbacks.onOpenBoard(item.data.childBoardId);
      }
    }
  }

  // ---- Pointer gestures --------------------------------------------------

  onPointerDown(event) {
    const target = event.target;

    if (
      !this.boardId
      || event.button === 2
      || (target instanceof Element && target.closest(".card-editor, .notice a, .notice button"))
    ) {
      return;
    }

    // Suppresses the compatibility mousedown, whose focus change would close
    // an editor opened by this tap. So focus is moved by hand: editing ends,
    // and fields outside the canvas (the board name) lose focus.
    event.preventDefault();
    this.finishEditing();

    const active = document.activeElement;

    if (active instanceof HTMLElement && active !== document.body && !this.canvas.contains(active)) {
      active.blur();
    }

    const point = this.viewport.localPoint(event);
    this.pointers.set(event.pointerId, point);

    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic or already-released pointers can't be captured.
    }

    if (this.pointers.size === 2) {
      this.cancelGesture();
      this.startPinch();
      return;
    }

    if (this.pointers.size > 2) {
      return;
    }

    const card = target instanceof Element ? target.closest(".card") : null;
    const id = card?.dataset.id;

    if (event.button === 1 || this.spaceDown) {
      this.gesture = { type: "pan", start: point, last: point, moved: false };
    } else if (id && target.closest(".resize-handle")) {
      this.startResize(id, point);
    } else if (id) {
      this.pressCard(id, event, point);
    } else if (event.shiftKey && event.pointerType === "mouse") {
      this.startMarquee(point);
    } else {
      this.gesture = { type: "pan", start: point, last: point, moved: false, onEmpty: true };
    }
  }

  onPointerMove(event) {
    if (!this.pointers.has(event.pointerId)) {
      return;
    }

    const point = this.viewport.localPoint(event);
    this.pointers.set(event.pointerId, point);

    const gesture = this.gesture;

    if (!gesture) {
      return;
    }

    if (gesture.type === "pinch") {
      this.updatePinch();
      return;
    }

    const threshold = event.pointerType === "mouse" ? 3 : 8;

    if (!gesture.moved && distance(point, gesture.start) < threshold) {
      return;
    }

    const firstMove = !gesture.moved;
    gesture.moved = true;

    if (gesture.type === "pan") {
      this.viewport.panBy(point.x - gesture.last.x, point.y - gesture.last.y);
    } else if (gesture.type === "card") {
      if (firstMove) {
        this.startDrag(gesture);
      }

      this.updateDrag(gesture, point);
    } else if (gesture.type === "resize") {
      this.updateResize(gesture, point);
    } else if (gesture.type === "marquee") {
      this.updateMarquee(gesture, point);
    }

    gesture.last = point;
  }

  onPointerUp(event, cancelled) {
    if (!this.pointers.delete(event.pointerId)) {
      return;
    }

    const gesture = this.gesture;

    // After a pinch, the finger still down does nothing until lifted.
    if (!gesture || (gesture.type === "pinch" && this.pointers.size)) {
      if (gesture?.type === "pinch") {
        this.gesture = null;
      }

      return;
    }

    if (cancelled) {
      this.cancelGesture();
      return;
    }

    this.gesture = null;

    if (gesture.type === "card") {
      if (gesture.moved) {
        this.endDrag(gesture);
      } else {
        this.tapCard(gesture, event);
      }
    } else if (gesture.type === "resize") {
      if (gesture.moved) {
        this.emit([gesture.id]);
      }
    } else if (gesture.type === "marquee") {
      gesture.element.remove();
    } else if (gesture.type === "pan" && !gesture.moved && gesture.onEmpty) {
      this.tapEmpty(gesture, event);
    }
  }

  // Ends whatever is in progress, keeping moves and resizes already made.
  cancelGesture() {
    const gesture = this.gesture;
    this.gesture = null;

    if (gesture?.type === "card" && gesture.moved) {
      this.endDrag(gesture);
    } else if (gesture?.type === "resize" && gesture.moved) {
      this.emit([gesture.id]);
    } else if (gesture?.type === "marquee") {
      gesture.element.remove();
    }
  }

  isDoubleTap(key, point, time) {
    const last = this.lastTap;
    const double = Boolean(last)
      && last.key === key
      && time - last.time < DOUBLE_TAP_MS
      && distance(point, last.point) < DOUBLE_TAP_DISTANCE;

    this.lastTap = double ? null : { key, point, time };
    return double;
  }

  pressCard(id, event, point) {
    const additive = event.shiftKey;
    let addedOnPress = false;

    if (!this.selected.has(id)) {
      if (!additive) {
        this.selected.clear();
      }

      this.selected.add(id);
      addedOnPress = true;
      this.renderSelection();
    }

    this.bringToFront(id);
    this.gesture = {
      type: "card",
      id,
      start: point,
      last: point,
      moved: false,
      additive,
      addedOnPress,
      target: event.target
    };
  }

  tapCard(gesture, event) {
    const { id, additive, addedOnPress, target } = gesture;

    if (additive) {
      if (!addedOnPress) {
        this.selected.delete(id);
        this.renderSelection();
      }

      return;
    }

    if (this.selected.size > 1) {
      this.setSelection([id]);
    }

    if (this.isDoubleTap(id, gesture.start, event.timeStamp)) {
      this.activateCard(id, target);
      return;
    }

    const link = target instanceof Element ? target.closest(".card a[href]") : null;

    if (link) {
      window.open(link.href, "_blank", "noopener,noreferrer");
    }
  }

  tapEmpty(gesture, event) {
    if (this.isDoubleTap("canvas", gesture.start, event.timeStamp)) {
      this.createCard("note", this.viewport.toWorld(gesture.start));
    } else if (!event.shiftKey && this.selected.size) {
      this.setSelection([]);
    }
  }

  startDrag(gesture) {
    gesture.origins = new Map(
      [...this.selected]
        .filter((id) => this.items.has(id))
        .map((id) => [id, { x: this.items.get(id).x, y: this.items.get(id).y }])
    );
  }

  updateDrag(gesture, point) {
    const zoom = this.viewport.zoom;
    const dx = (point.x - gesture.start.x) / zoom;
    const dy = (point.y - gesture.start.y) / zoom;

    for (const [id, origin] of gesture.origins) {
      const item = this.items.get(id);

      if (item) {
        item.x = clampCoordinate(origin.x + dx);
        item.y = clampCoordinate(origin.y + dy);
        positionCard(this.elements.get(id), item);
      }
    }
  }

  endDrag(gesture) {
    this.emit([...gesture.origins.keys()]);
  }

  startResize(id, point) {
    if (!this.selected.has(id)) {
      this.setSelection([id]);
    }

    this.bringToFront(id);

    const item = this.items.get(id);
    this.gesture = {
      type: "resize",
      id,
      start: point,
      last: point,
      moved: false,
      origin: { w: item.w, h: item.h }
    };
  }

  updateResize(gesture, point) {
    const item = this.items.get(gesture.id);

    if (!item) {
      return;
    }

    const limits = CARD_TYPES[item.type];
    const zoom = this.viewport.zoom;

    item.w = Math.round(clamp(gesture.origin.w + (point.x - gesture.start.x) / zoom, limits.minW, MAX_CARD_SIZE));
    item.h = Math.round(clamp(gesture.origin.h + (point.y - gesture.start.y) / zoom, limits.minH, MAX_CARD_SIZE));
    positionCard(this.elements.get(gesture.id), item);
  }

  startMarquee(point) {
    const element = document.createElement("div");
    element.className = "marquee";
    this.canvas.append(element);

    this.gesture = {
      type: "marquee",
      start: point,
      last: point,
      moved: false,
      base: new Set(this.selected),
      element
    };
  }

  updateMarquee(gesture, point) {
    const left = Math.min(gesture.start.x, point.x);
    const top = Math.min(gesture.start.y, point.y);
    const width = Math.abs(point.x - gesture.start.x);
    const height = Math.abs(point.y - gesture.start.y);
    const style = gesture.element.style;

    style.left = `${left}px`;
    style.top = `${top}px`;
    style.width = `${width}px`;
    style.height = `${height}px`;

    const from = this.viewport.toWorld({ x: left, y: top });
    const to = this.viewport.toWorld({ x: left + width, y: top + height });
    const selected = new Set(gesture.base);

    for (const item of this.items.values()) {
      if (item.x < to.x && item.x + item.w > from.x && item.y < to.y && item.y + item.h > from.y) {
        selected.add(item.id);
      }
    }

    this.selected = selected;
    this.renderSelection();
  }

  startPinch() {
    const [a, b] = [...this.pointers.values()];
    const center = midpoint(a, b);

    this.gesture = {
      type: "pinch",
      startDistance: Math.max(1, distance(a, b)),
      startZoom: this.viewport.zoom,
      anchor: this.viewport.toWorld(center)
    };
  }

  updatePinch() {
    const [a, b] = [...this.pointers.values()];
    const gesture = this.gesture;

    this.viewport.zoomAround(
      gesture.anchor,
      midpoint(a, b),
      gesture.startZoom * (distance(a, b) / gesture.startDistance)
    );
  }

  onWheel(event) {
    if (!this.boardId) {
      return;
    }

    event.preventDefault();

    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewport.height : 1;
    const delta = clamp(event.deltaY * unit, -300, 300);
    // Trackpad pinches arrive as ctrl+wheel with small deltas.
    const speed = event.ctrlKey ? 0.01 : 0.0015;

    this.viewport.zoomAt(this.viewport.localPoint(event), Math.exp(-delta * speed));
  }

  // ---- Keyboard ------------------------------------------------------------

  setSpaceDown(down) {
    this.spaceDown = down;
    this.canvas.classList.toggle("is-space-panning", down);
  }

  onKeyDown(event) {
    if (!this.boardId || isTextField(event.target) || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    if (event.key === " ") {
      if (event.target instanceof Element && event.target.closest("button, a")) {
        return;
      }

      event.preventDefault();

      if (!event.repeat) {
        this.setSpaceDown(true);
      }
    } else if (event.key === "Delete" || event.key === "Backspace") {
      if (this.selected.size) {
        event.preventDefault();
        this.deleteSelected();
      }
    } else if (event.key === "Escape") {
      this.setSelection([]);
    }
  }
}
