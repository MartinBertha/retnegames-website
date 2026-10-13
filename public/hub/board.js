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
import { Viewport } from "./viewport.js";

const COORDINATE_LIMIT = 1_000_000;
const MAX_CARD_SIZE = 10_000;
const MAX_NAME_LENGTH = 100;
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_DISTANCE = 24;
const LONG_PRESS_MS = 550;
const CASCADE_OFFSET = 24;
const IMAGE_CARD_EDGE = 320;
const FIT_PADDING = 48;
const POINTER_MEMORY_MS = 10_000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const clampCoordinate = (value) => Math.round(clamp(value, -COORDINATE_LIMIT, COORDINATE_LIMIT));
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
      return { text: "", size: "m" };
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
  // onFoldersDeleted(names)
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
      const card = event.target instanceof Element ? event.target.closest(".card") : null;

      if (!card || isTextField(event.target)) {
        return;
      }

      event.preventDefault();

      if (!this.selected.has(card.dataset.id)) {
        this.setSelection([card.dataset.id]);
      }

      this.openMenu(event.clientX, event.clientY);
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

  // Adds a card centred on a world point. New cards with an editor open it;
  // the card is saved (and undoable) once that edit ends.
  createCard(type, center, { data, size, edit = true } = {}) {
    if (!this.boardId) {
      return null;
    }

    this.finishEditing();

    const { w, h } = size ?? CARD_TYPES[type];
    const item = this.addItem({
      id: crypto.randomUUID(),
      type,
      x: clampCoordinate(center.x - w / 2),
      y: clampCoordinate(center.y - h / 2),
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

  addImageCard({ fileId, width, height }, center) {
    const limits = CARD_TYPES.image;
    let size = { w: limits.w, h: limits.h };

    if (width > 0 && height > 0) {
      const scale = Math.min(1, IMAGE_CARD_EDGE / Math.max(width, height));
      size = {
        w: Math.round(clamp(width * scale, limits.minW, MAX_CARD_SIZE)),
        h: Math.round(clamp(height * scale, limits.minH, MAX_CARD_SIZE))
      };
    }

    return this.createCard("image", center, { data: { fileId, caption: "" }, size, edit: false });
  }

  addLinkCard(url, center) {
    return this.createCard("link", center, { data: { url, title: "" }, edit: false });
  }

  addNoteCard(text, center) {
    return this.createCard("note", center, { data: { text, size: "m" }, edit: false });
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
      positionCard(card, item);
    }
  }

  // Notes grow taller while typing rather than scrolling.
  growToFit(item, card, editor) {
    const overflow = editor.scrollHeight - editor.clientHeight;

    if (overflow > 0) {
      item.h = Math.min(MAX_CARD_SIZE, Math.ceil(item.h + overflow));
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
    this.menu.open(clientX, clientY, {
      colors: new Set(items.map((item) => item.color)),
      noteSizes: new Set(items.filter((item) => item.type === "note").map((item) => item.data.size))
    });
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
    }
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
    this.editing = { id, before, ...startEditor(this, item, card, options) };
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
  }

  // Double-click or double-tap on a card.
  activateCard(id, target) {
    const item = this.items.get(id);
    const element = target instanceof Element ? target : null;

    if (item.type === "folder" && !element?.closest(".folder-name")) {
      this.callbacks.onOpenBoard(item.data.childBoardId);
    } else {
      this.startEditing(id, { focusEntryId: element?.closest(".entry")?.dataset.entryId });
    }
  }

  // ---- Pointer gestures --------------------------------------------------

  onPointerDown(event) {
    const target = event.target instanceof Element ? event.target : null;

    if (
      !this.boardId
      || event.button === 2
      || target?.closest(".card-editor, .card-control, .notice a, .notice button")
    ) {
      return;
    }

    // Suppresses the compatibility mousedown, whose focus change would close
    // an editor opened by this tap. So focus is moved by hand: editing ends,
    // and fields outside the canvas (the board name) lose focus.
    event.preventDefault();
    this.finishEditing();
    this.menu.close();

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
      this.gesture = { type: "pan", start: point, last: point, moved: false, onEmpty: true };
    }
  }

  onPointerMove(event) {
    const point = this.viewport.localPoint(event);
    this.lastPointer = { point, time: Date.now() };

    if (!this.pointers.has(event.pointerId)) {
      return;
    }

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
    clearTimeout(gesture.longPress);

    if (gesture.type === "pan") {
      this.viewport.panBy(point.x - gesture.last.x, point.y - gesture.last.y);
    } else if (gesture.type === "card") {
      if (firstMove) {
        this.startDrag(gesture);
      }

      this.updateDrag(gesture, point);
    } else if (gesture.type === "resize") {
      this.updateResize(gesture, point, event.shiftKey);
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
      this.createCard("note", this.viewport.toWorld(gesture.start));
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

  // Images keep their proportions unless Shift is held.
  updateResize(gesture, point, free) {
    const item = this.items.get(gesture.id);

    if (!item) {
      return;
    }

    const limits = CARD_TYPES[item.type];
    const zoom = this.viewport.zoom;
    const { w, h } = gesture.origin;
    let width = clamp(w + (point.x - gesture.start.x) / zoom, limits.minW, MAX_CARD_SIZE);
    let height = clamp(h + (point.y - gesture.start.y) / zoom, limits.minH, MAX_CARD_SIZE);

    if (item.type === "image" && !free) {
      const ratio = w / h;
      width = Math.max(width, height * ratio);
      height = width / ratio;

      if (height > MAX_CARD_SIZE || width > MAX_CARD_SIZE) {
        const scale = Math.min(MAX_CARD_SIZE / width, MAX_CARD_SIZE / height);
        width *= scale;
        height *= scale;
      }
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
      const step = event.shiftKey ? 10 : 1;
      this.nudgeSelected(nudge[0] * step, nudge[1] * step);
    } else if ((key === "f" || key === "F") && !event.shiftKey) {
      event.preventDefault();
      this.fitAll();
    } else if (key === "ContextMenu" || (key === "F10" && event.shiftKey)) {
      event.preventDefault();
      this.openMenu();
    }
  }
}
