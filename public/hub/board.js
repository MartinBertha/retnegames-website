// The canvas of the open board: its cards, the selection, undo and redo, and
// all pointer and keyboard interaction (docs/hub-spec.md, section 6).
//
// Mouse: drag empty canvas to pan, Shift-drag for a marquee, Space-drag or the
// middle button pans anywhere, wheel or trackpad pinch zooms, right-click
// opens the card menu. Touch: one finger pans (or drags a card), two fingers
// pinch-zoom and pan, long-press opens the card menu. Double-click or
// double-tap edits a card, opens a folder, or adds a note on empty canvas.

import { moveEntry, toggleEntry } from "./checklist.js";
import {
  CARD_TYPES,
  createCardElement,
  invalidateCard,
  positionCard,
  updateCardElement
} from "./cards.js";
import { startEditor } from "./editors.js";
import { History } from "./history.js";
import { CardMenu } from "./menu.js";
import { GRID, Viewport } from "./viewport.js";

const COORDINATE_LIMIT = 1_000_000;
const MAX_CARD_SIZE = 10_000;
const MAX_NAME_LENGTH = 100;
const MAX_ITEMS_PER_BOARD = 2_000;
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_DISTANCE = 24;
const LONG_PRESS_MS = 550;
const CASCADE_OFFSET = GRID;
const IMAGE_CARD_EDGE = 336;
const FIT_PADDING = 48;
const POINTER_MEMORY_MS = 10_000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const clampCoordinate = (value) => Math.round(clamp(value, -COORDINATE_LIMIT, COORDINATE_LIMIT));
const snapToGrid = (value) => Math.round(value / GRID) * GRID;
const gridCeil = (value) => Math.ceil(value / GRID) * GRID;
// The next grid line past value in a direction (+1 or -1).
const nextGridLine = (value, direction) => (
  direction > 0 ? Math.floor(value / GRID + 1) * GRID : Math.ceil(value / GRID - 1) * GRID
);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const sameState = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function isTextField(target) {
  return target instanceof Element
    && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function snapshot({ id, type, x, y, w, h, z, color, data }) {
  return { id, type, x, y, w, h, z, color, data };
}

function defaultData(type) {
  switch (type) {
    case "note":
      return { title: "", text: "", size: "m" };
    case "checklist":
      return { title: "", entries: [] };
    case "link":
      return { url: "", title: "" };
    case "section":
      return { title: "" };
    case "folder":
      return { name: "New folder", childBoardId: crypto.randomUUID() };
    default:
      return {};
  }
}

export class BoardView {
  // callbacks: onOps(boardId, ops), onOpenBoard(id), onSelectionChange(count),
  // onViewChange(), onItemsChange(count), onHistoryChange(history),
  // onFoldersDeleted(names), onClipboard(action, worldPoint), canPaste(),
  // isOnPath(boardId), onNotice(message)
  constructor(canvas, world, callbacks) {
    this.canvas = canvas;
    this.world = world;
    this.callbacks = callbacks;
    this.viewport = new Viewport(canvas, world, () => callbacks.onViewChange?.());
    this.history = new History(() => callbacks.onHistoryChange?.(this.history));
    this.menu = new CardMenu((action) => this.runMenuAction(action));
    this.boardId = null;
    this.items = new Map();
    this.elements = new Map();
    this.selected = new Set();
    this.editing = null;
    this.gesture = null;
    this.pointers = new Map();
    this.lastTap = null;
    this.lastPointer = null;
    this.spaceDown = false;
    this.snapEnabled = true;
    this.modifiers = { shift: false, alt: false };

    // Sections always sit behind the other cards.
    this.layers = { section: document.createElement("div"), card: document.createElement("div") };
    this.layers.section.className = "layer layer-sections";
    this.layers.card.className = "layer layer-cards";
    world.append(this.layers.section, this.layers.card);

    this.bindEvents();
  }

  bindEvents() {
    const canvas = this.canvas;

    canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.onPointerUp(event, false));
    canvas.addEventListener("pointercancel", (event) => this.onPointerUp(event, true));
    canvas.addEventListener("pointerleave", () => {
      this.lastPointer = null;
    });
    canvas.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });

    // Links open from the tap handler, so a drag never opens one.
    canvas.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest(".card a")) {
        event.preventDefault();
      }
    }, true);

    // Buttons inside cards (checklist ticks, "Add item") use plain clicks.
    this.world.addEventListener("click", (event) => {
      const control = event.target instanceof Element ? event.target.closest(".card-control") : null;
      const id = control?.closest(".card")?.dataset.id;

      if (!id || !this.items.has(id)) {
        return;
      }

      if (control.classList.contains("entry-check")) {
        this.toggleChecklistEntry(id, control.closest(".entry").dataset.entryId);
      } else if (control.classList.contains("entry-add")) {
        if (this.editing?.id === id) {
          this.editing.addEntry?.();
        } else {
          this.startEditing(id, { appendEntry: true });
        }
      }
    });

    canvas.addEventListener("contextmenu", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const card = target?.closest(".card");

      if (isTextField(target)) {
        return;
      }

      event.preventDefault();

      if (!card) {
        this.openCanvasMenu(event.clientX, event.clientY);
        return;
      }

      if (!this.selected.has(card.dataset.id)) {
        this.setSelection([card.dataset.id]);
      }

      this.openMenu(event.clientX, event.clientY);
    });

    // Safari's own pinch would zoom the whole page.
    canvas.addEventListener("gesturestart", (event) => event.preventDefault());

    // Keyboard focus (Tab) selects the card and brings it into view.
    this.world.addEventListener("focusin", (event) => {
      const card = event.target;

      if (card instanceof Element && card.classList.contains("card")) {
        if (!this.selected.has(card.dataset.id)) {
          this.setSelection([card.dataset.id]);
        }

        this.ensureVisible(card.dataset.id);
      }
    });

    // Phones: keep the field being edited above the on-screen keyboard.
    window.visualViewport?.addEventListener("resize", () => this.keepEditorInView());

    // Shift (no snapping) and Alt (free image proportions) apply mid-drag.
    document.addEventListener("keydown", (event) => this.trackModifiers(event), true);
    document.addEventListener("keyup", (event) => this.trackModifiers(event), true);

    document.addEventListener("keydown", (event) => this.onKeyDown(event));
    document.addEventListener("keyup", (event) => {
      if (event.key === " ") {
        this.setSpaceDown(false);
      }
    });
    window.addEventListener("blur", () => {
      this.setSpaceDown(false);
      this.setModifiers({ shiftKey: false, altKey: false });
    });
  }

  trackModifiers(event) {
    // Alt on its own would focus the browser's menu bar in some browsers.
    if (event.key === "Alt" && this.gesture) {
      event.preventDefault();
    }

    this.setModifiers(event);
  }

  setModifiers({ shiftKey, altKey }) {
    if (shiftKey === this.modifiers.shift && altKey === this.modifiers.alt) {
      return;
    }

    this.modifiers = { shift: shiftKey, alt: altKey };

    const gesture = this.gesture;

    if (gesture?.moved && gesture.last) {
      if (gesture.type === "card") {
        this.updateDrag(gesture, gesture.last);
      } else if (gesture.type === "resize") {
        this.updateResize(gesture, gesture.last);
      }
    }
  }

  // ---- Grid snapping ----------------------------------------------------
  // On by default (the ⋯ menu switches it off per device); holding Shift
  // places, moves and resizes freely.

  setSnapEnabled(enabled) {
    this.snapEnabled = enabled;
  }

  snapping(free = this.modifiers.shift) {
    return this.snapEnabled && !free;
  }

  // Where a new card goes: centred on a world point, with its top-left corner
  // on the grid when snapping.
  placementRect(type, center, { size, free } = {}) {
    const { w, h } = size ?? CARD_TYPES[type];
    let x = center.x - w / 2;
    let y = center.y - h / 2;

    if (this.snapping(free)) {
      x = snapToGrid(x);
      y = snapToGrid(y);
    }

    return { x: clampCoordinate(x), y: clampCoordinate(y), w, h };
  }

  // The same rectangle in window pixels (the outline while placing from the toolbar).
  placementPreview(type, event) {
    const rect = this.placementRect(type, this.worldPointAt(event), { free: event.shiftKey });
    const canvas = this.canvas.getBoundingClientRect();
    const corner = this.viewport.toScreen(rect);
    const zoom = this.viewport.zoom;

    return { left: canvas.left + corner.x, top: canvas.top + corner.y, width: rect.w * zoom, height: rect.h * zoom };
  }

  // Moves a card's far edge (start + size) onto the nearest grid line,
  // keeping at least minSize.
  snapEdge(start, size, minSize) {
    let edge = snapToGrid(start + size);

    if (edge - start < minSize) {
      edge = gridCeil(start + minSize);
    }

    if (edge - start > MAX_CARD_SIZE) {
      edge = Math.floor((start + MAX_CARD_SIZE) / GRID) * GRID;
    }

    return edge - start;
  }

  // Cards that grow with their content end on a grid line.
  snapGrownHeight(item) {
    if (this.snapEnabled) {
      item.h = Math.min(MAX_CARD_SIZE, gridCeil(item.y + item.h) - item.y);
    }
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
    this.itemsChanged();
  }

  clear() {
    this.reset();
    this.renderSelection();
  }

  reset() {
    this.finishEditing();
    this.cancelGesture();
    this.menu.close();
    this.pointers.clear();
    this.boardId = null;
    this.items.clear();
    this.elements.clear();
    this.selected.clear();
    this.lastTap = null;
    this.layers.section.replaceChildren();
    this.layers.card.replaceChildren();
    this.history.clear();
  }

  isBusy() {
    return Boolean(this.gesture || this.editing);
  }

  itemsChanged() {
    this.callbacks.onItemsChange?.(this.items.size);
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
      if (item.id !== editingId) {
        this.setItemState(item.id, item);
      }
    }

    this.selected = new Set([...this.selected].filter((id) => this.items.has(id)));
    this.renderSelection();
    this.itemsChanged();
  }

  // ---- Cards -------------------------------------------------------------

  addItem(item) {
    const copy = structuredClone(snapshot(item));
    const element = createCardElement(copy);
    this.items.set(copy.id, copy);
    this.elements.set(copy.id, element);
    (copy.type === "section" ? this.layers.section : this.layers.card).append(element);
    return copy;
  }

  removeItem(id) {
    this.elements.get(id)?.remove();
    this.elements.delete(id);
    this.items.delete(id);
    this.selected.delete(id);
  }

  // Replaces a card's state, adding the card if needed (null removes it).
  setItemState(id, state) {
    if (!state) {
      this.removeItem(id);
      return;
    }

    const item = this.items.get(id);

    if (!item) {
      this.addItem(state);
      return;
    }

    Object.assign(item, structuredClone(snapshot(state)));
    updateCardElement(this.elements.get(id), item);
  }

  // Saves cards as they are now, without an undo step (typing, bring to front).
  emit(ids) {
    const ops = ids
      .filter((id) => this.items.has(id))
      .map((id) => ({ op: "upsert", item: snapshot(this.items.get(id)) }));

    if (ops.length && this.boardId) {
      this.callbacks.onOps(this.boardId, ops);
    }
  }

  capture(ids) {
    return new Map(ids.map((id) => [id, this.items.has(id) ? structuredClone(snapshot(this.items.get(id))) : null]));
  }

  // Saves what changed since `before` (from capture) and records one undo step.
  commitChange(before, { mergeKey = null } = {}) {
    const after = this.capture([...before.keys()]);
    const changedBefore = new Map();
    const changedAfter = new Map();

    for (const [id, state] of before) {
      if (!sameState(state, after.get(id))) {
        changedBefore.set(id, state);
        changedAfter.set(id, after.get(id));
      }
    }

    if (!changedAfter.size || !this.boardId) {
      return;
    }

    this.callbacks.onOps(this.boardId, [...changedAfter].map(([id, state]) => (
      state ? { op: "upsert", item: state } : { op: "delete", id }
    )));
    this.history.push(changedBefore, changedAfter, mergeKey);
    this.syncFolderNames(changedAfter);
  }

  // Several folder cards can open one board; a rename shows on all of them
  // (the server renames the ones it stores).
  syncFolderNames(states) {
    for (const state of states.values()) {
      if (state?.type !== "folder") {
        continue;
      }

      for (const item of this.items.values()) {
        if (item.type === "folder" && item.id !== state.id
          && item.data.childBoardId === state.data.childBoardId && item.data.name !== state.data.name) {
          item.data.name = state.data.name;
          updateCardElement(this.elements.get(item.id), item);
        }
      }
    }
  }

  // Undo and redo restore whole card states.
  applyStates(states) {
    const ops = [];

    for (const [id, state] of states) {
      this.setItemState(id, state);
      ops.push(state ? { op: "upsert", item: structuredClone(state) } : { op: "delete", id });
    }

    this.setSelection([...states].filter(([, state]) => state).map(([id]) => id));
    this.itemsChanged();

    if (ops.length && this.boardId) {
      this.callbacks.onOps(this.boardId, ops);
    }
  }

  undo() {
    this.finishEditing();
    this.menu.close();
    const step = this.history.undo();

    if (step) {
      this.applyStates(step.before);
    }
  }

  redo() {
    this.finishEditing();
    this.menu.close();
    const step = this.history.redo();

    if (step) {
      this.applyStates(step.after);
    }
  }

  maxZ() {
    let max = 0;

    for (const item of this.items.values()) {
      max = Math.max(max, item.z);
    }

    return max;
  }

  minZ() {
    let min = 0;

    for (const item of this.items.values()) {
      min = Math.min(min, item.z);
    }

    return min;
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

  // Adds a card centred on a world point (snapped to the grid unless `free`).
  // New cards with an editor open it; the card is saved (and undoable) once
  // that edit ends.
  createCard(type, center, { data, size, edit = true, free } = {}) {
    if (!this.boardId) {
      return null;
    }

    this.finishEditing();

    const { x, y, w, h } = this.placementRect(type, center, { size, free });
    const item = this.addItem({
      id: crypto.randomUUID(),
      type,
      x,
      y,
      w,
      h,
      z: this.maxZ() + 1,
      color: null,
      data: data ?? defaultData(type)
    });

    this.setSelection([item.id]);
    this.itemsChanged();

    if (edit) {
      this.startEditing(item.id, { fresh: true, selectAll: type === "folder" });
    } else {
      this.growToContent(item.id);
      this.commitChange(new Map([[item.id, null]]));
    }

    return item;
  }

  // The middle of the view, nudged off cards already there.
  freeSpotInView(type, offset = 0) {
    const size = CARD_TYPES[type];
    const middle = this.viewport.centerWorld();
    let center = { x: middle.x + offset, y: middle.y + offset };

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

    return center;
  }

  createCardInView(type) {
    this.createCard(type, this.freeSpotInView(type));
  }

  // Where pasted content goes: under the pointer if it's over the canvas.
  pastePoint() {
    if (this.lastPointer && Date.now() - this.lastPointer.time < POINTER_MEMORY_MS) {
      return this.viewport.toWorld(this.lastPointer.point);
    }

    return this.freeSpotInView("note");
  }

  worldPointAt(event) {
    return this.viewport.toWorld(this.viewport.localPoint(event));
  }

  // options: { free } places it off the grid (Shift held during a drop).
  addImageCard({ fileId, width, height }, center, options = {}) {
    const limits = CARD_TYPES.image;
    let size = { w: limits.w, h: limits.h };

    if (width > 0 && height > 0) {
      const scale = Math.min(1, IMAGE_CARD_EDGE / Math.max(width, height));
      size = {
        w: Math.round(clamp(width * scale, limits.minW, MAX_CARD_SIZE)),
        h: Math.round(clamp(height * scale, limits.minH, MAX_CARD_SIZE))
      };
    }

    return this.createCard("image", center, { ...options, data: { fileId, caption: "" }, size, edit: false });
  }

  addLinkCard(url, center, options = {}) {
    return this.createCard("link", center, { ...options, data: { url, title: "" }, edit: false });
  }

  addNoteCard(text, center, options = {}) {
    return this.createCard("note", center, { ...options, data: { title: "", text, size: "m" }, edit: false });
  }

  // Grows a note or checklist so its content isn't cut off.
  growToContent(id) {
    const item = this.items.get(id);
    const card = this.elements.get(id);

    if (!item || !card || (item.type !== "note" && item.type !== "checklist")) {
      return;
    }

    const box = item.type === "note" ? card.querySelector(".note-text") : card;
    const overflow = box.scrollHeight - box.clientHeight;

    if (overflow > 0) {
      item.h = Math.min(MAX_CARD_SIZE, Math.ceil(item.h + overflow));
      this.snapGrownHeight(item);
      positionCard(card, item);
    }
  }

  // Notes grow taller while typing rather than scrolling.
  growToFit(item, card, editor) {
    const overflow = editor.scrollHeight - editor.clientHeight;

    if (overflow > 0) {
      item.h = Math.min(MAX_CARD_SIZE, Math.ceil(item.h + overflow));
      this.snapGrownHeight(item);
      positionCard(card, item);
    }
  }

  deleteSelected() {
    this.finishEditing();

    if (!this.selected.size || !this.boardId) {
      return;
    }

    const ids = [...this.selected];
    const before = this.capture(ids);
    const folders = [...before.values()].filter((item) => item.type === "folder");

    for (const id of ids) {
      this.removeItem(id);
    }

    this.renderSelection();
    this.itemsChanged();
    this.commitChange(before);

    // Deleting a folder takes its whole board with it; undo brings it back.
    if (folders.length) {
      this.callbacks.onFoldersDeleted?.(folders.map((folder) => folder.data.name));
    }
  }

  duplicateSelected() {
    this.finishEditing();

    const sources = [...this.selected]
      .map((id) => this.items.get(id))
      .filter(Boolean)
      .sort((a, b) => a.z - b.z);

    if (!sources.length) {
      return;
    }

    let z = this.maxZ();
    const created = sources.map((source) => {
      const copy = structuredClone(snapshot(source));
      copy.id = crypto.randomUUID();
      copy.x = clampCoordinate(source.x + CASCADE_OFFSET);
      copy.y = clampCoordinate(source.y + CASCADE_OFFSET);
      copy.z = ++z;

      if (copy.type === "checklist") {
        copy.data.entries = copy.data.entries.map((entry) => ({ ...entry, id: crypto.randomUUID() }));
      } else if (copy.type === "folder") {
        // A copied folder gets a new, empty board of its own.
        copy.data.childBoardId = crypto.randomUUID();
        copy.data.name = `${copy.data.name} copy`.slice(0, MAX_NAME_LENGTH);
      }

      this.addItem(copy);
      return copy.id;
    });

    this.setSelection(created);
    this.itemsChanged();
    this.commitChange(new Map(created.map((id) => [id, null])));
  }

  changeSelected(mutate) {
    this.finishEditing();

    const ids = [...this.selected].filter((id) => this.items.has(id));
    const before = this.capture(ids);

    for (const id of ids) {
      mutate(this.items.get(id));
      updateCardElement(this.elements.get(id), this.items.get(id));
    }

    this.commitChange(before);
  }

  // Keeps the order among the selected cards.
  restackSelected(toFront) {
    const items = [...this.selected]
      .map((id) => this.items.get(id))
      .filter(Boolean)
      .sort((a, b) => (toFront ? a.z - b.z : b.z - a.z));
    let z = toFront ? this.maxZ() : this.minZ();
    const order = new Map(items.map((item) => [item.id, toFront ? ++z : --z]));

    this.changeSelected((item) => {
      item.z = order.get(item.id);
    });
  }

  nudgeSelected(dx, dy) {
    const ids = [...this.selected].filter((id) => this.items.has(id)).sort();
    const before = this.capture(ids);

    for (const id of ids) {
      const item = this.items.get(id);
      item.x = clampCoordinate(item.x + dx);
      item.y = clampCoordinate(item.y + dy);
      positionCard(this.elements.get(id), item);
    }

    this.commitChange(before, { mergeKey: `nudge:${ids.join(",")}` });
  }

  // Arrow keys with snapping: the first selected card moves to the next grid
  // line in that direction; the others keep their layout.
  nudgeSelectedToGrid(dirX, dirY) {
    const anchor = this.items.get([...this.selected].find((id) => this.items.has(id)));

    if (anchor) {
      this.nudgeSelected(
        dirX ? nextGridLine(anchor.x, dirX) - anchor.x : 0,
        dirY ? nextGridLine(anchor.y, dirY) - anchor.y : 0
      );
    }
  }

  toggleChecklistEntry(id, entryId) {
    const item = this.items.get(id);

    if (!item || item.type !== "checklist") {
      return;
    }

    if (this.editing?.id === id) {
      item.data.entries = toggleEntry(item.data.entries, entryId);
      this.editing.rerender();
      this.emit([id]);
      return;
    }

    const before = this.capture([id]);
    item.data.entries = toggleEntry(item.data.entries, entryId);
    updateCardElement(this.elements.get(id), item);
    this.commitChange(before);
  }

  zoomBy(factor) {
    this.viewport.measure();
    this.viewport.zoomAt({ x: this.viewport.width / 2, y: this.viewport.height / 2 }, factor);
  }

  resetZoom() {
    this.zoomBy(1 / this.viewport.zoom);
  }

  // Pans just enough to show a card (or as much of it as fits).
  ensureVisible(id) {
    const card = this.elements.get(id);

    if (!card) {
      return;
    }

    const margin = 24;
    const view = this.canvas.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    let dx = 0;
    let dy = 0;

    if (rect.left < view.left + margin || rect.width > view.width - margin * 2) {
      dx = view.left + margin - rect.left;
    } else if (rect.right > view.right - margin) {
      dx = view.right - margin - rect.right;
    }

    if (rect.top < view.top + margin || rect.height > view.height - margin * 2) {
      dy = view.top + margin - rect.top;
    } else if (rect.bottom > view.bottom - margin) {
      dy = view.bottom - margin - rect.bottom;
    }

    if (dx || dy) {
      this.viewport.panBy(dx, dy);
    }
  }

  // When the on-screen keyboard covers the field being edited, pan it up.
  keepEditorInView() {
    const field = document.activeElement;
    const visual = window.visualViewport;

    if (!this.editing || !visual || !(field instanceof HTMLElement) || !this.canvas.contains(field)) {
      return;
    }

    const rect = field.getBoundingClientRect();
    const canvasTop = this.canvas.getBoundingClientRect().top;
    const bottom = visual.offsetTop + visual.height - 16;

    if (rect.bottom > bottom) {
      this.viewport.panBy(0, Math.max(bottom - rect.bottom, canvasTop + 16 - rect.top));
    }
  }

  // Frames every card on the board.
  fitAll() {
    this.viewport.measure();

    if (!this.items.size) {
      this.viewport.setView(0, 0, 1);
      return;
    }

    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;

    for (const item of this.items.values()) {
      left = Math.min(left, item.x);
      top = Math.min(top, item.y);
      right = Math.max(right, item.x + item.w);
      bottom = Math.max(bottom, item.y + item.h);
    }

    const zoom = Math.min(
      1,
      (this.viewport.width - FIT_PADDING * 2) / (right - left),
      (this.viewport.height - FIT_PADDING * 2) / (bottom - top)
    );

    this.viewport.setView((left + right) / 2, (top + bottom) / 2, zoom);
  }

  // ---- Selection and menu -----------------------------------------------

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

  // Opens the card menu at a screen point, or by the first selected card.
  openMenu(clientX, clientY) {
    const items = [...this.selected].map((id) => this.items.get(id)).filter(Boolean);

    if (!items.length) {
      return;
    }

    if (clientX === undefined) {
      const rect = this.elements.get(items[0].id).getBoundingClientRect();
      clientX = rect.left + 12;
      clientY = rect.top + 12;
    }

    this.finishEditing();
    this.menuPoint = this.viewport.toWorld(this.viewport.localPoint({ clientX, clientY }));
    this.menu.open(clientX, clientY, {
      colors: new Set(items.map((item) => item.color)),
      noteSizes: new Set(items.filter((item) => item.type === "note").map((item) => item.data.size)),
      canPaste: Boolean(this.callbacks.canPaste?.())
    });
  }

  // Right-click or long-press on empty canvas: Paste.
  openCanvasMenu(clientX, clientY) {
    this.finishEditing();
    this.setSelection([]);
    this.menuPoint = this.viewport.toWorld(this.viewport.localPoint({ clientX, clientY }));
    this.menu.open(clientX, clientY, { canvas: true, canPaste: Boolean(this.callbacks.canPaste?.()) });
  }

  runMenuAction({ type, value }) {
    if (type === "color") {
      this.changeSelected((item) => {
        item.color = value;
      });
    } else if (type === "size") {
      this.changeSelected((item) => {
        if (item.type === "note") {
          item.data.size = value;
        }
      });
    } else if (type === "duplicate") {
      this.duplicateSelected();
    } else if (type === "front") {
      this.restackSelected(true);
    } else if (type === "back") {
      this.restackSelected(false);
    } else if (type === "delete") {
      this.deleteSelected();
    } else if (type === "copy" || type === "cut" || type === "paste") {
      this.callbacks.onClipboard?.(type, type === "paste" ? this.menuPoint : null);
    }
  }

  // ---- Copy and paste ------------------------------------------------------

  // The selected cards (with the cards inside selected sections), in stacking order.
  copySelection() {
    const ids = new Set([...this.selected].filter((id) => this.items.has(id)));

    for (const id of [...ids]) {
      const section = this.items.get(id);

      if (section.type !== "section") {
        continue;
      }

      for (const other of this.items.values()) {
        const cx = other.x + other.w / 2;
        const cy = other.y + other.h / 2;

        if (other !== section && cx >= section.x && cx <= section.x + section.w
          && cy >= section.y && cy <= section.y + section.h) {
          ids.add(other.id);
        }
      }
    }

    return [...ids]
      .map((id) => structuredClone(snapshot(this.items.get(id))))
      .sort((a, b) => a.z - b.z);
  }

  // Adds copies of cards, centred as a group on a world point and keeping their
  // layout; the group's corner snaps to the grid unless `free`. A folder card
  // copy opens the same board as the original.
  pasteCards(sources, center, { free } = {}) {
    if (!this.boardId || !sources.length) {
      return;
    }

    this.finishEditing();

    const cards = sources.filter((item) => item.type !== "folder" || !this.callbacks.isOnPath?.(item.data.childBoardId));

    if (cards.length < sources.length) {
      this.callbacks.onNotice?.("A folder can't go inside itself, so it wasn't pasted.");
    }

    if (!cards.length) {
      return;
    }

    if (this.items.size + cards.length > MAX_ITEMS_PER_BOARD) {
      this.callbacks.onNotice?.(`A board can hold at most ${MAX_ITEMS_PER_BOARD.toLocaleString("en")} cards.`);
      return;
    }

    const left = Math.min(...cards.map((item) => item.x));
    const top = Math.min(...cards.map((item) => item.y));
    const right = Math.max(...cards.map((item) => item.x + item.w));
    const bottom = Math.max(...cards.map((item) => item.y + item.h));
    let x = center.x - (right - left) / 2;
    let y = center.y - (bottom - top) / 2;

    if (this.snapping(free)) {
      x = snapToGrid(x);
      y = snapToGrid(y);
    }

    x = Math.round(x);
    y = Math.round(y);

    // Pasting again on the same spot steps down and right.
    const taken = (dx, dy) => cards.some((card) => [...this.items.values()].some((item) => (
      item.type === card.type && item.x === card.x - left + dx && item.y === card.y - top + dy
    )));

    for (let step = 0; step < 50 && taken(x, y); step++) {
      x += GRID;
      y += GRID;
    }

    let z = this.maxZ();
    const created = cards.map((source) => {
      const copy = structuredClone(source);
      copy.id = crypto.randomUUID();
      copy.x = source.x - left + x;
      copy.y = source.y - top + y;
      copy.z = ++z;

      if (copy.type === "checklist") {
        copy.data.entries = copy.data.entries.map((entry) => ({ ...entry, id: crypto.randomUUID() }));
      }

      this.addItem(copy);
      return copy.id;
    });

    this.setSelection(created);
    this.itemsChanged();
    this.commitChange(new Map(created.map((id) => [id, null])));
  }

  // ---- Editing -----------------------------------------------------------

  startEditing(id, options = {}) {
    this.finishEditing();

    const item = this.items.get(id);
    const card = this.elements.get(id);

    if (!item || !card) {
      return;
    }

    const before = options.fresh ? new Map([[id, null]]) : this.capture([id]);

    this.setSelection([id]);
    card.classList.add("is-editing");
    this.editing = { id, before, restoreFocus: Boolean(options.restoreFocus), ...startEditor(this, item, card, options) };
    requestAnimationFrame(() => this.keepEditorInView());
  }

  // One undo step per edit. A new card left empty is removed.
  finishEditing() {
    const editing = this.editing;

    if (!editing) {
      return;
    }

    this.editing = null;

    const card = this.elements.get(editing.id);
    const item = this.items.get(editing.id);
    const keep = editing.finish();

    if (!item || !card) {
      return;
    }

    card.classList.remove("is-editing");

    if (keep === false) {
      this.removeItem(editing.id);
      this.renderSelection();
      this.itemsChanged();
      this.callbacks.onOps(this.boardId, [{ op: "delete", id: editing.id }]);
      return;
    }

    invalidateCard(card);
    updateCardElement(card, item);
    this.growToContent(editing.id);
    this.commitChange(editing.before);

    // Editing started from the keyboard: return focus to the card.
    if (editing.restoreFocus && (!document.activeElement || document.activeElement === document.body)) {
      card.focus({ preventScroll: true });
    }
  }

  // Double-click or double-tap on a card, or Enter on a focused card.
  activateCard(id, target, { restoreFocus = false } = {}) {
    const item = this.items.get(id);
    const element = target instanceof Element ? target : null;

    if (item.type === "folder" && !element?.closest(".folder-name")) {
      this.callbacks.onOpenBoard(item.data.childBoardId, item.data.name);
    } else {
      this.startEditing(id, {
        focusEntryId: element?.closest(".entry")?.dataset.entryId,
        focusTitle: Boolean(element?.closest(".note-title")),
        restoreFocus
      });
    }
  }

  // ---- Pointer gestures --------------------------------------------------

  onPointerDown(event) {
    const target = event.target instanceof Element ? event.target : null;

    if (
      !this.boardId
      || event.button === 2
      || target?.closest(".card-editor, .card-control, .canvas-overlay, .notice a, .notice button")
    ) {
      return;
    }

    // Suppresses the compatibility mousedown, whose focus change would close
    // an editor opened by this tap. So focus is moved by hand: editing ends,
    // and whatever had focus (a card, the board name field) loses it.
    event.preventDefault();
    this.finishEditing();
    this.menu.close();

    const active = document.activeElement;

    if (active instanceof HTMLElement && active !== document.body) {
      active.blur();
    }

    const point = this.viewport.localPoint(event);
    this.pointers.set(event.pointerId, point);
    this.setModifiers(event);

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

    const card = target?.closest(".card");
    const id = card?.dataset.id;

    if (event.button === 1 || this.spaceDown) {
      this.gesture = { type: "pan", start: point, last: point, moved: false };
    } else if (id && target.closest(".resize-handle")) {
      this.startResize(id, point);
    } else if (id && target.closest(".entry-handle")) {
      this.startReorder(id, target.closest(".entry"), point);
    } else if (id) {
      this.pressCard(id, event, point);
    } else if (event.shiftKey && event.pointerType === "mouse") {
      this.startMarquee(point);
    } else {
      const gesture = { type: "pan", start: point, last: point, moved: false, onEmpty: true };

      // Touch: holding still on empty canvas opens the Paste menu.
      if (event.pointerType !== "mouse") {
        const { clientX, clientY } = event;
        gesture.longPress = setTimeout(() => {
          if (this.gesture === gesture && !gesture.moved) {
            this.gesture = null;
            this.lastTap = null;
            this.openCanvasMenu(clientX, clientY);
          }
        }, LONG_PRESS_MS);
      }

      this.gesture = gesture;
    }
  }

  onPointerMove(event) {
    const point = this.viewport.localPoint(event);
    this.lastPointer = { point, time: Date.now() };

    if (!this.pointers.has(event.pointerId)) {
      return;
    }

    this.pointers.set(event.pointerId, point);
    this.setModifiers(event);

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
    clearTimeout(gesture.longPress);

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
    } else if (gesture.type === "reorder") {
      this.updateReorder(gesture, point, event.clientY);
    }

    gesture.last = point;
  }

  onPointerUp(event, cancelled) {
    if (!this.pointers.delete(event.pointerId)) {
      return;
    }

    const gesture = this.gesture;

    // Re-read Shift/Alt once the gesture is over, so a stale state can't linger.
    queueMicrotask(() => this.setModifiers(event));

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
    clearTimeout(gesture.longPress);

    if (gesture.type === "card") {
      if (gesture.moved) {
        this.endDrag(gesture);
      } else {
        this.tapCard(gesture, event);
      }
    } else if (gesture.type === "resize" || gesture.type === "reorder") {
      this.endEdit(gesture);
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
    clearTimeout(gesture?.longPress);

    if (gesture?.type === "card" && gesture.moved) {
      this.endDrag(gesture);
    } else if (gesture?.type === "resize" || gesture?.type === "reorder") {
      this.endEdit(gesture);
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

    if (this.items.get(id).type !== "section") {
      this.bringToFront(id);
    }

    const gesture = {
      type: "card",
      id,
      start: point,
      last: point,
      moved: false,
      additive,
      addedOnPress,
      target: event.target
    };

    // Touch: holding still opens the card menu.
    if (event.pointerType !== "mouse") {
      const { clientX, clientY } = event;
      gesture.longPress = setTimeout(() => {
        if (this.gesture === gesture && !gesture.moved) {
          this.gesture = null;
          this.lastTap = null;
          this.openMenu(clientX, clientY);
        }
      }, LONG_PRESS_MS);
    }

    this.gesture = gesture;
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
      this.createCard("note", this.viewport.toWorld(gesture.start), { free: event.shiftKey });
    } else if (!event.shiftKey && this.selected.size) {
      this.setSelection([]);
    }
  }

  // Dragging a section also moves the cards whose centre is inside it.
  startDrag(gesture) {
    const ids = new Set([...this.selected].filter((id) => this.items.has(id)));

    for (const id of [...ids]) {
      const section = this.items.get(id);

      if (section.type !== "section") {
        continue;
      }

      for (const other of this.items.values()) {
        const cx = other.x + other.w / 2;
        const cy = other.y + other.h / 2;

        if (
          other !== section
          && cx >= section.x && cx <= section.x + section.w
          && cy >= section.y && cy <= section.y + section.h
        ) {
          ids.add(other.id);
        }
      }
    }

    gesture.before = this.capture([...ids]);
    gesture.origins = new Map([...ids].map((id) => [id, { x: this.items.get(id).x, y: this.items.get(id).y }]));
  }

  // The grabbed card's top-left corner lands on the grid (unless Shift is
  // held); every other moving card shifts by the same amount.
  updateDrag(gesture, point) {
    const zoom = this.viewport.zoom;
    let dx = (point.x - gesture.start.x) / zoom;
    let dy = (point.y - gesture.start.y) / zoom;
    const anchor = gesture.origins.get(gesture.id);

    if (anchor && this.snapping()) {
      dx = snapToGrid(anchor.x + dx) - anchor.x;
      dy = snapToGrid(anchor.y + dy) - anchor.y;
    }

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
    this.commitChange(gesture.before);
  }

  startResize(id, point) {
    if (!this.selected.has(id)) {
      this.setSelection([id]);
    }

    if (this.items.get(id).type !== "section") {
      this.bringToFront(id);
    }

    const item = this.items.get(id);
    this.gesture = {
      type: "resize",
      id,
      start: point,
      last: point,
      moved: false,
      before: this.capture([id]),
      origin: { w: item.w, h: item.h }
    };
  }

  // The right and bottom edges land on grid lines (unless Shift is held).
  // Images keep their proportions unless Alt is held; then only the right
  // edge snaps and the height follows.
  updateResize(gesture, point) {
    const item = this.items.get(gesture.id);

    if (!item) {
      return;
    }

    const limits = CARD_TYPES[item.type];
    const zoom = this.viewport.zoom;
    const { w, h } = gesture.origin;
    const snap = this.snapping();
    let width = clamp(w + (point.x - gesture.start.x) / zoom, limits.minW, MAX_CARD_SIZE);
    let height = clamp(h + (point.y - gesture.start.y) / zoom, limits.minH, MAX_CARD_SIZE);

    if (item.type === "image" && !this.modifiers.alt) {
      const ratio = w / h;
      const minWidth = Math.max(limits.minW, limits.minH * ratio);
      const maxWidth = Math.min(MAX_CARD_SIZE, MAX_CARD_SIZE * ratio);

      width = Math.max(width, height * ratio);

      if (snap) {
        width = this.snapEdge(item.x, width, minWidth);
      }

      width = clamp(width, minWidth, maxWidth);
      height = width / ratio;
    } else if (snap) {
      width = this.snapEdge(item.x, width, limits.minW);
      height = this.snapEdge(item.y, height, limits.minH);
    }

    item.w = Math.round(width);
    item.h = Math.round(height);
    positionCard(this.elements.get(gesture.id), item);
  }

  endEdit(gesture) {
    if (gesture.type === "reorder") {
      this.endReorder(gesture);
    }

    if (gesture.moved) {
      this.commitChange(gesture.before);
    }
  }

  // Dragging an unticked checklist entry by its handle.
  startReorder(id, row, point) {
    this.setSelection([id]);
    row.classList.add("is-dragging");
    this.gesture = {
      type: "reorder",
      id,
      row,
      entryId: row.dataset.entryId,
      start: point,
      last: point,
      moved: false,
      index: null,
      before: this.capture([id])
    };
  }

  updateReorder(gesture, point, clientY) {
    const card = this.elements.get(gesture.id);
    const rows = [...card.querySelectorAll(".entry:not(.is-done)")].filter((row) => row !== gesture.row);
    let index = rows.length;

    gesture.row.style.transform = `translateY(${(point.y - gesture.start.y) / this.viewport.zoom}px)`;

    for (const [i, row] of rows.entries()) {
      const rect = row.getBoundingClientRect();

      if (clientY < rect.top + rect.height / 2) {
        index = i;
        break;
      }
    }

    gesture.index = index;

    for (const [i, row] of rows.entries()) {
      row.classList.toggle("drop-before", i === index);
    }

    rows.at(-1)?.classList.toggle("drop-after", index === rows.length);
  }

  endReorder(gesture) {
    const card = this.elements.get(gesture.id);
    const item = this.items.get(gesture.id);

    gesture.row.classList.remove("is-dragging");
    gesture.row.style.transform = "";

    for (const row of card?.querySelectorAll(".drop-before, .drop-after") ?? []) {
      row.classList.remove("drop-before", "drop-after");
    }

    if (item && gesture.moved && gesture.index !== null) {
      item.data.entries = moveEntry(item.data.entries, gesture.entryId, gesture.index);
      updateCardElement(card, item);
    }
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

  // Cards touched by the marquee are selected; sections must be fully inside.
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
      const inside = item.type === "section"
        ? item.x >= from.x && item.x + item.w <= to.x && item.y >= from.y && item.y + item.h <= to.y
        : item.x < to.x && item.x + item.w > from.x && item.y < to.y && item.y + item.h > from.y;

      if (inside) {
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
    this.menu.close();

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
    if (!this.boardId || isTextField(event.target) || this.menu.element.contains(event.target)) {
      return;
    }

    const key = event.key;
    const mod = event.ctrlKey || event.metaKey;

    if (mod && !event.altKey) {
      const letter = key.toLowerCase();
      const action = {
        z: () => (event.shiftKey ? this.redo() : this.undo()),
        y: () => this.redo(),
        d: () => this.duplicateSelected(),
        a: () => this.setSelection([...this.items.keys()])
      }[letter];

      if (action && (letter !== "y" || event.ctrlKey)) {
        event.preventDefault();
        action();
      }

      return;
    }

    if (event.altKey) {
      return;
    }

    const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];

    if (key === " ") {
      if (event.target instanceof Element && event.target.closest("button, a")) {
        return;
      }

      event.preventDefault();

      if (!event.repeat) {
        this.setSpaceDown(true);
      }
    } else if (key === "Delete" || key === "Backspace") {
      if (this.selected.size) {
        event.preventDefault();
        this.deleteSelected();
      }
    } else if (key === "Escape") {
      this.menu.close();
      this.setSelection([]);
    } else if (nudge && this.selected.size) {
      event.preventDefault();
      // Snapping: one grid step (Shift: 1px). Snapping off: 1px (Shift: 10px).
      if (this.snapping(event.shiftKey)) {
        this.nudgeSelectedToGrid(nudge[0], nudge[1]);
      } else {
        const step = this.snapEnabled || !event.shiftKey ? 1 : 10;
        this.nudgeSelected(nudge[0] * step, nudge[1] * step);
      }
    } else if ((key === "f" || key === "F") && !event.shiftKey) {
      event.preventDefault();
      this.fitAll();
    } else if (key === "+" || key === "=") {
      event.preventDefault();
      this.zoomBy(1.25);
    } else if (key === "-" || key === "_") {
      event.preventDefault();
      this.zoomBy(0.8);
    } else if (key === "0") {
      event.preventDefault();
      this.resetZoom();
    } else if (key === "Enter" && event.target instanceof Element && event.target.classList.contains("card")) {
      event.preventDefault();
      this.activateCard(event.target.dataset.id, event.target, { restoreFocus: true });
    } else if (key === "ContextMenu" || (key === "F10" && event.shiftKey)) {
      event.preventDefault();
      this.openMenu();
    }
  }
}
