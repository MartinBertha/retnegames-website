// "Backups" (docs/hub-spec.md, section 6): the daily backups the server saves
// (src/hub/backups.js). Each can be downloaded, or restored as a copy in a
// new folder on Home; nothing that exists is changed.

import { api, backupUrl } from "./api.js";
import { dialogButton, el, openDialog } from "./dialog.js";
import { formatDate, formatSize, plural } from "./labels.js";

// The cron trigger in wrangler.jsonc: 03:17 UTC.
const BACKUP_UTC = { hour: 3, minute: 17 };

function intro(keep) {
  const time = new Date(Date.UTC(2000, 0, 1, BACKUP_UTC.hour, BACKUP_UTC.minute))
    .toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  return `Every day at about ${time} the hub saves a backup of all boards and cards, `
    + `if anything changed. The newest ${keep} are kept. Images aren't copied into backups `
    + "(they stay in the hub's storage); for a copy with images, use Export with images.";
}

// onRestored(result): a backup was added as a folder on Home (result.boardId).
export async function openBackups({ onRestored, flush }) {
  const { body, close } = openDialog({ title: "Backups", intro: intro(30) });
  const actions = el("div", "dialog-actions");
  const message = el("p", "dialog-message");
  const list = el("ul", "dialog-list");
  const status = el("p", "dialog-status", "Loading…");

  const backUp = dialogButton("Back up now", async () => {
    backUp.disabled = true;
    backUp.textContent = "Backing up…";
    message.classList.remove("is-error");
    message.textContent = "";

    try {
      await flush();
      const result = await api.backUpNow();
      message.textContent = result.created
        ? "Backup saved."
        : `Nothing has changed since the last backup (${formatDate(result.backup.createdAt)}).`;
      await refresh();
    } catch (error) {
      message.textContent = error.message || "The backup failed.";
      message.classList.add("is-error");
    } finally {
      backUp.disabled = false;
      backUp.textContent = "Back up now";
    }
  }, "dialog-button is-primary");

  actions.append(backUp, message);
  body.replaceChildren(actions, status);

  async function refresh() {
    let result;

    try {
      result = await api.listBackups();
    } catch (error) {
      status.textContent = error.message || "The backups couldn't be loaded.";
      body.replaceChildren(actions, status);
      return;
    }

    if (!result.backups.length) {
      status.textContent = "No backups yet. The first one is saved tonight, or now with Back up now.";
      body.replaceChildren(actions, status);
      return;
    }

    list.replaceChildren(...result.backups.map((backup) => backupRow(backup, { close, onRestored })));
    body.replaceChildren(actions, list);
  }

  await refresh();
}

function backupRow(backup, { close, onRestored }) {
  const row = el("li", "dialog-row");
  const main = el("div", "dialog-row-main");
  const meta = el("p", "dialog-row-meta", [
    plural(backup.boards, "board"),
    plural(backup.cards, "card"),
    formatSize(backup.size)
  ].join(" · "));
  const download = el("a", "dialog-button", "Download");

  main.append(el("p", "dialog-row-title", formatDate(backup.createdAt)), meta);
  download.href = backupUrl(backup.name);
  download.download = backup.name;

  const restore = dialogButton("Restore a copy", async () => {
    restore.disabled = true;
    restore.textContent = "Restoring…";
    meta.classList.remove("is-error");

    try {
      const result = await api.restoreBackup(backup.name);
      close();
      onRestored(result);
    } catch (error) {
      meta.textContent = error.message || "The backup couldn't be restored.";
      meta.classList.add("is-error");
      restore.disabled = false;
      restore.textContent = "Restore a copy";
    }
  });

  restore.title = "Adds this backup as a new folder on Home. Nothing is overwritten.";
  row.append(main, el("div", "dialog-row-actions"));
  row.lastChild.append(download, restore);
  return row;
}
