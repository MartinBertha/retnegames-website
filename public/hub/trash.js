// "Recently deleted" (docs/hub-spec.md, section 6): the deleted cards on
// boards that still exist, newest first. Restore saves a card again where it
// was; a folder brings back its board and everything in it. Empty notes,
// checklists and links aren't listed.

import { api, fileUrl } from "./api.js";
import { dialogButton, el, openDialog } from "./dialog.js";
import { cardLabel, formatWhen, isBlankCard, typeName } from "./labels.js";

const INTRO = "Deleted cards are kept here. Restore puts a card back where it was. "
  + "Restoring a folder also brings back its board and everything in it.";

// onRestored(entry): saved again. onShow(entry): go to it on its board.
export async function openTrash({ onRestored, onShow }) {
  const { body, close } = openDialog({ title: "Recently deleted", intro: INTRO });
  const status = el("p", "dialog-status", "Loading…");
  body.replaceChildren(status);

  let result;

  try {
    result = await api.listTrash();
  } catch (error) {
    status.textContent = error.message || "The list couldn't be loaded.";
    return;
  }

  const entries = result.items.filter((entry) => !isBlankCard(entry.item));

  if (!entries.length) {
    status.textContent = "Nothing has been deleted.";
    return;
  }

  const list = el("ul", "dialog-list");
  list.append(...entries.map((entry) => trashRow(entry, { onRestored, onShow: (shown) => {
    close();
    onShow(shown);
  } })));
  body.replaceChildren(list);

  if (result.items.length >= result.limit) {
    body.append(el("p", "dialog-note", `Only the ${result.limit} most recently deleted cards are listed.`));
  }
}

function trashRow(entry, { onRestored, onShow }) {
  const { item } = entry;
  const row = el("li", "dialog-row");
  const main = el("div", "dialog-row-main");
  const title = el("p", "dialog-row-title", cardLabel(item, 90));
  const meta = el("p", "dialog-row-meta", `${typeName(item.type)} on ${entry.boardName} · deleted ${formatWhen(entry.deletedAt)}`);
  let restored = false;

  if (item.type === "image" && item.data?.fileId) {
    const thumb = el("img", "dialog-thumb");
    thumb.src = fileUrl(item.data.fileId);
    thumb.alt = "";
    thumb.loading = "lazy";
    thumb.decoding = "async";
    row.append(thumb);
  }

  title.title = cardLabel(item, 200);
  main.append(title, meta);

  const button = dialogButton("Restore", async () => {
    if (restored) {
      onShow(entry);
      return;
    }

    button.disabled = true;
    button.textContent = "Restoring…";
    meta.classList.remove("is-error");

    try {
      await api.saveChanges(entry.boardId, [{ op: "upsert", item }]);
      restored = true;
      button.textContent = "Show";
      meta.textContent = item.type === "folder"
        ? `Restored to ${entry.boardName}, with everything in it`
        : `Restored to ${entry.boardName}`;
      onRestored(entry);
    } catch (error) {
      button.textContent = "Restore";
      meta.textContent = error.message || "It couldn't be restored.";
      meta.classList.add("is-error");
    } finally {
      button.disabled = false;
    }
  });

  row.append(main, button);
  return row;
}
