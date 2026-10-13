// retne hub, milestone 1: loads the board named in the URL hash (#/b/<id>,
// no hash = Home) and shows its breadcrumb. User data only ever reaches the
// DOM through textContent.

import { api, ApiError } from "./api.js";

const breadcrumb = document.getElementById("breadcrumb");
const notice = document.getElementById("notice");

const BOARD_HASH = /^#\/b\/([0-9a-f-]{36})$/;

let loadCounter = 0;

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

function renderBreadcrumb(path) {
  breadcrumb.replaceChildren(...path.map((entry, index) => {
    const item = el("li");

    if (index === path.length - 1) {
      const current = el("span", "", entry.name);
      current.setAttribute("aria-current", "page");
      item.append(current);
    } else {
      const link = el("a", "", entry.name);
      link.href = `#/b/${entry.id}`;
      item.append(link);
    }

    return item;
  }));
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

async function load() {
  const current = ++loadCounter;

  try {
    let id = boardIdFromHash();

    if (!id) {
      const { rootId } = await api.listBoards();
      id = rootId;
    }

    const { board, path, items } = await api.getBoard(id);

    if (current !== loadCounter) {
      return;
    }

    renderBreadcrumb(path);
    document.title = `${board.name} · retne hub`;

    showNotice(
      items.length ? `${items.length} cards on this board.` : "This board is empty.",
      "The canvas arrives in the next milestone."
    );
  } catch (error) {
    if (current !== loadCounter) {
      return;
    }

    breadcrumb.replaceChildren();
    document.title = "retne hub";
    showError(error);
  }
}

window.addEventListener("hashchange", load);
load();
