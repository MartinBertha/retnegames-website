// retne hub: loads the board named in the URL hash (#/b/<id>, no hash = Home),
// autosaves card changes, and picks up changes made on other devices.
// User data only ever reaches the DOM through textContent.

import { api, ApiError } from "./api.js";
import { BoardView } from "./board.js";
import { Saver } from "./saver.js";

const breadcrumb = document.getElementById("breadcrumb");
const notice = document.getElementById("notice");
const saveStatus = document.getElementById("save-status");
const deleteButton = document.getElementById("delete-selection");

const BOARD_HASH = /^#\/b\/([0-9a-f-]{36})$/;
const REV_POLL_MS = 15_000;
const VIEW_SAVE_MS = 1_000;
const LEAVE_FLUSH_TIMEOUT_MS = 5_000;
const LOADING_NOTICE_DELAY_MS = 300;
const MAX_VIEW_COORDINATE = 2_000_000;
const NARROW_SCREEN = window.matchMedia("(max-width: 600px)");

const STATUS_TEXT = {
  saved: "Saved",
  saving: "Saving…",
  offline: "Offline, retrying",
  expired: "Session expired, retrying",
  error: "Some changes weren't saved"
};

// The open board: { id, parentId, name, rev, path }.
let current = null;
let loadCounter = 0;
let checking = false;
let viewTimer = null;
let savedView = null;

const saver = new Saver({
  save: (boardId, ops, options) => api.saveChanges(boardId, ops, options),
  onStatus: showSaveStatus,
  onSaved: (boardId, rev) => {
    if (current?.id !== boardId) {
      return;
    }

    // Exactly one more than we knew: only our own change happened. Otherwise
    // check once this save has finished.
    if (rev > current.rev + 1) {
      setTimeout(checkForUpdates, 0);
    } else {
      current.rev = Math.max(current.rev, rev);
    }
  },
  onRejected: (error) => console.error("hub: changes rejected:", error.status, error.message)
});

const view = new BoardView(
  document.getElementById("canvas"),
  document.getElementById("world"),
  {
    onOps: (boardId, ops) => saver.queue(boardId, ops),
    onOpenBoard: (id) => {
      window.location.hash = `#/b/${id}`;
    },
    onSelectionChange: (count) => {
      deleteButton.disabled = count === 0;
    },
    onViewChange: scheduleViewSave,
    onItemsChange: showEmptyHint
  }
);

function showSaveStatus(state) {
  saveStatus.textContent = STATUS_TEXT[state];
  saveStatus.dataset.state = state;
}

function boardIdFromHash() {
  return BOARD_HASH.exec(window.location.hash)?.[1] ?? null;
}

function el(tag, className, text) {
  const node = document.createElement(tag);

  if (className) {
    node.className = className;
  }

  if (text !== undefined) {
    node.textContent = text;
  }

  return node;
}

function showNotice(title, detail, action) {
  const children = [el("p", "notice-title", title)];

  if (detail) {
    children.push(el("p", "", detail));
  }

  if (action) {
    children.push(action);
  }

  notice.replaceChildren(...children);
}

function showEmptyHint(count) {
  if (!current) {
    return;
  }

  if (count === 0) {
    showNotice("This board is empty.", "Double-click or double-tap to add a note, or use the toolbar.");
  } else {
    notice.replaceChildren();
  }
}

function homeLink() {
  const link = el("a", "notice-action", "Go to Home");
  link.href = "#/";
  return link;
}

function reloadButton() {
  const button = el("button", "notice-action", "Reload");
  button.type = "button";
  button.addEventListener("click", () => window.location.reload());
  return button;
}

function showError(error) {
  const status = error instanceof ApiError ? error.status : 0;

  if (status === 404) {
    showNotice("Board not found.", "It may have been deleted.", homeLink());
  } else if (status === 401) {
    showNotice("Session expired.", error.message, reloadButton());
  } else if (status === 403) {
    showNotice("No access.", "This account isn't allowed to use the hub.");
  } else {
    showNotice("Couldn't load the board.", error.message, reloadButton());
  }
}

// ---- Breadcrumb ------------------------------------------------------------

// Long paths keep Home and the last few boards; the middle becomes "…".
function visibleCrumbs(path) {
  const max = NARROW_SCREEN.matches ? 3 : 6;

  if (path.length <= max) {
    return path;
  }

  const tail = path.slice(path.length - (max - 2));
  const hidden = path.slice(1, path.length - (max - 2));
  return [path[0], { hidden }, ...tail];
}

function renderBreadcrumb() {
  if (!current) {
    breadcrumb.replaceChildren();
    return;
  }

  const path = current.path;
  const crumbs = visibleCrumbs(path);

  breadcrumb.replaceChildren(...crumbs.map((entry, index) => {
    const item = el("li");

    if (entry.hidden) {
      const more = el("span", "crumb-more", "…");
      more.title = entry.hidden.map((board) => board.name).join(" › ");
      item.append(more);
    } else if (index < crumbs.length - 1) {
      const link = el("a", "", entry.name);
      link.href = `#/b/${entry.id}`;
      item.append(link);
    } else if (current.parentId === null) {
      const name = el("span", "crumb-current", entry.name);
      name.setAttribute("aria-current", "page");
      item.append(name);
    } else {
      const button = el("button", "crumb-current", entry.name);
      button.type = "button";
      button.title = "Rename board";
      button.setAttribute("aria-current", "page");
      button.addEventListener("click", () => startBoardRename(button));
      item.append(button);
    }

    return item;
  }));

  document.title = `${current.name} · retne hub`;
}

function startBoardRename(button) {
  const board = current;
  const input = el("input", "crumb-editor");
  let done = false;

  input.type = "text";
  input.value = board.name;
  input.maxLength = 100;
  input.enterKeyHint = "done";
  input.setAttribute("aria-label", "Board name");
  button.replaceWith(input);
  input.focus();
  input.select();

  // Pressing anywhere else commits, even where the press doesn't move focus
  // (the canvas cancels pointerdown).
  const onPointerDown = (event) => {
    if (event.target !== input) {
      finish(true);
    }
  };

  document.addEventListener("pointerdown", onPointerDown, true);

  const finish = async (save) => {
    if (done) {
      return;
    }

    done = true;
    document.removeEventListener("pointerdown", onPointerDown, true);

    const name = input.value.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
    const previous = board.name;

    if (!save || !name || name === previous || current !== board) {
      renderBreadcrumb();
      return;
    }

    board.name = name;
    board.path[board.path.length - 1].name = name;
    renderBreadcrumb();

    try {
      const { board: updated } = await api.updateBoard(board.id, { name });

      if (current === board) {
        if (updated.rev > board.rev + 1) {
          checkForUpdates();
        } else {
          board.rev = updated.rev;
        }
      }
    } catch (error) {
      board.name = previous;
      board.path[board.path.length - 1].name = previous;
      renderBreadcrumb();
      saveStatus.textContent = error.message || "Couldn't rename the board.";
      saveStatus.dataset.state = "error";
    }
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      finish(event.key === "Enter");
    }
  });

  input.addEventListener("blur", () => finish(true));
}

NARROW_SCREEN.addEventListener("change", renderBreadcrumb);

// ---- Loading and syncing ---------------------------------------------------

// Server items with this device's unsaved changes on top.
function withLocalChanges(boardId, items) {
  const merged = new Map(items.map((item) => [item.id, item]));

  for (const op of saver.localOps(boardId)) {
    if (op.op === "delete") {
      merged.delete(op.id);
    } else {
      merged.set(op.item.id, op.item);
    }
  }

  return [...merged.values()];
}

// Saves the open board's view and changes before showing another board.
async function leaveBoard() {
  if (!current) {
    return;
  }

  view.finishEditing();
  saveView();
  view.clear();
  current = null;
  renderBreadcrumb();

  await Promise.race([
    saver.flush(),
    new Promise((resolve) => setTimeout(resolve, LEAVE_FLUSH_TIMEOUT_MS))
  ]);
}

async function load() {
  const counter = ++loadCounter;
  const loading = setTimeout(() => showNotice("Loading…"), LOADING_NOTICE_DELAY_MS);

  try {
    await leaveBoard();

    let id = boardIdFromHash();

    if (!id) {
      ({ rootId: id } = await api.listBoards());
    }

    const { board, path, items } = await api.getBoard(id);

    if (counter !== loadCounter) {
      return;
    }

    current = { ...board, path };
    savedView = { viewX: board.viewX, viewY: board.viewY, viewZoom: board.viewZoom };
    notice.replaceChildren();
    renderBreadcrumb();
    view.show(board.id, { x: board.viewX, y: board.viewY, zoom: board.viewZoom }, withLocalChanges(board.id, items));
  } catch (error) {
    if (counter !== loadCounter) {
      return;
    }

    current = null;
    view.clear();
    renderBreadcrumb();
    document.title = "retne hub";
    showError(error);
  } finally {
    clearTimeout(loading);
  }
}

// Refetches the board when another device changed it (rev moved on).
async function checkForUpdates() {
  const board = current;

  if (
    !board
    || checking
    || document.visibilityState !== "visible"
    || view.isBusy()
    || saver.hasUnsaved(board.id)
  ) {
    return;
  }

  checking = true;

  try {
    const { rev } = await api.getBoardRev(board.id);

    if (current !== board || rev <= board.rev) {
      return;
    }

    const data = await api.getBoard(board.id);

    // Busy again: the next check picks it up.
    if (current !== board || view.isBusy()) {
      return;
    }

    Object.assign(board, data.board, { path: data.path });
    renderBreadcrumb();
    view.applyRemote(withLocalChanges(board.id, data.items));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && current === board) {
      current = null;
      view.clear();
      renderBreadcrumb();
      showNotice("This board was deleted.", "It may have been deleted on another device.", homeLink());
    }
  } finally {
    checking = false;
  }
}

// ---- View (pan and zoom) ---------------------------------------------------

function scheduleViewSave() {
  if (current) {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(saveView, VIEW_SAVE_MS);
  }
}

const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;
const clampView = (value) => Math.min(MAX_VIEW_COORDINATE, Math.max(-MAX_VIEW_COORDINATE, value));

// Best effort: a failed save is retried with the next pan or zoom.
function saveView({ keepalive = false } = {}) {
  clearTimeout(viewTimer);
  viewTimer = null;

  if (!current || view.boardId !== current.id) {
    return;
  }

  const center = view.viewport.centerWorld();
  const next = {
    viewX: round(clampView(center.x), 1),
    viewY: round(clampView(center.y), 1),
    viewZoom: round(view.viewport.zoom, 3)
  };

  if (
    savedView
    && savedView.viewX === next.viewX
    && savedView.viewY === next.viewY
    && savedView.viewZoom === next.viewZoom
  ) {
    return;
  }

  const boardId = current.id;
  savedView = next;

  api.updateBoard(boardId, next, { keepalive }).catch(() => {
    if (current?.id === boardId) {
      savedView = null;
    }
  });
}

// ---- Toolbar and page events -----------------------------------------------

document.getElementById("add-note").addEventListener("click", () => view.createCardInView("note"));
document.getElementById("add-folder").addEventListener("click", () => view.createCardInView("folder"));
deleteButton.addEventListener("click", () => view.deleteSelected());

window.addEventListener("hashchange", load);
window.addEventListener("focus", checkForUpdates);
window.addEventListener("online", () => saver.flush());

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    checkForUpdates();
  } else {
    // Edits are queued as they're typed, so open editors can stay open.
    saveView({ keepalive: true });
    saver.flush({ keepalive: true });
  }
});

window.addEventListener("beforeunload", (event) => {
  if (saver.hasUnsaved()) {
    event.preventDefault();
    event.returnValue = "";
  }
});

setInterval(checkForUpdates, REV_POLL_MS);
load();
