// In-place editors, one per card type. startEditor() sets up the editing UI
// and returns { finish }, which restores the static card and returns false
// when a new card should be discarded because it was left empty.
// Values reach the item only as plain strings.

import { addEntry, removeEntry } from "./checklist.js";
import { httpUrl, renderChecklist } from "./cards.js";

const MAX_NOTE_LENGTH = 20_000;
const MAX_TITLE_LENGTH = 100;
const MAX_CAPTION_LENGTH = 500;
const MAX_URL_LENGTH = 2_048;
const MAX_ENTRIES = 200;

const oneLine = (value) => value.replace(/[\u0000-\u001f\u007f]+/g, " ");

function textInput(className, value, label, maxLength) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = `card-editor ${className}`;
  input.value = value;
  input.maxLength = maxLength;
  input.enterKeyHint = "done";
  input.setAttribute("aria-label", label);
  return input;
}

function focusEnd(field) {
  field.focus({ preventScroll: true });
  field.setSelectionRange?.(field.value.length, field.value.length);
}

// Leaving the card ends editing; switching to another window doesn't.
function onFocusLeave(view, card, isPaused = () => false) {
  const handler = (event) => {
    if (!isPaused() && !card.contains(event.relatedTarget) && document.hasFocus()) {
      view.finishEditing();
    }
  };

  card.addEventListener("focusout", handler);
  return () => card.removeEventListener("focusout", handler);
}

// "example.com" becomes "https://example.com"; anything else must be http(s).
function normaliseUrl(value) {
  let url = value.trim();

  if (!url) {
    return null;
  }

  if (!/^[a-z][a-z\d+.-]*:/i.test(url)) {
    url = `https://${url}`;
  }

  const href = httpUrl(url);
  return href && href.length <= MAX_URL_LENGTH ? href : null;
}

function noteEditor(view, item, card, { fresh }) {
  const text = card.querySelector(".note-text");
  const editor = document.createElement("textarea");

  editor.className = "card-editor note-editor";
  editor.value = item.data.text;
  editor.maxLength = MAX_NOTE_LENGTH;
  editor.setAttribute("aria-label", "Note text");
  text.hidden = true;
  card.insertBefore(editor, card.querySelector(".resize-handle"));

  // Saved as you type; the undo step covers the whole edit.
  editor.addEventListener("input", () => {
    item.data.text = editor.value;
    view.growToFit(item, card, editor);
    view.emit([item.id]);
  });

  editor.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      view.finishEditing();
    }
  });

  const stop = onFocusLeave(view, card);
  focusEnd(editor);
  view.growToFit(item, card, editor);

  return {
    finish() {
      stop();
      editor.remove();
      text.hidden = false;
      return !(fresh && !item.data.text.trim());
    }
  };
}

// Folder names, image captions and section titles: Enter saves, Escape cancels.
function lineEditor(view, item, card, { anchor, className, label, maxLength, field, required, selectAll }) {
  const input = textInput(className, item.data[field], label, maxLength);
  let cancelled = false;

  anchor.hidden = true;
  anchor.after(input);

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      cancelled = event.key === "Escape";
      view.finishEditing();
    }
  });

  const stop = onFocusLeave(view, card);
  focusEnd(input);

  if (selectAll) {
    input.select();
  }

  return {
    finish() {
      stop();
      input.remove();
      anchor.hidden = false;

      const value = oneLine(input.value).trim();

      if (!cancelled && (value || !required)) {
        item.data[field] = value;
      }

      return true;
    }
  };
}

function linkEditor(view, item, card, { fresh }) {
  const title = card.querySelector(".link-title");
  const host = card.querySelector(".link-host");
  const form = document.createElement("div");
  const url = textInput("link-url-editor", item.data.url, "Link address", MAX_URL_LENGTH);
  const name = textInput("link-title-editor", item.data.title, "Link title", MAX_TITLE_LENGTH);

  form.className = "link-editor";
  url.type = "url";
  url.inputMode = "url";
  url.placeholder = "https://…";
  url.spellcheck = false;
  url.enterKeyHint = "next";
  name.placeholder = "Title (optional)";
  title.hidden = true;
  host.hidden = true;
  form.append(url, name);
  card.insertBefore(form, card.querySelector(".resize-handle"));

  // Saved when editing ends, so a half-typed address is never sent.
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || (event.key === "Enter" && event.target === name)) {
      event.preventDefault();
      view.finishEditing();
    } else if (event.key === "Enter") {
      event.preventDefault();
      focusEnd(name);
    }
  });

  const stop = onFocusLeave(view, card);
  focusEnd(fresh || !item.data.url ? url : name);

  return {
    finish() {
      stop();
      form.remove();
      title.hidden = false;
      host.hidden = false;

      const href = normaliseUrl(url.value);

      if (href) {
        item.data.url = href;
      }

      item.data.title = oneLine(name.value).trim();
      return Boolean(item.data.url);
    }
  };
}

function checklistEditor(view, item, card, { fresh, focusEntryId, appendEntry }) {
  let rendering = false;

  const fields = () => [...card.querySelectorAll(".checklist-title-editor, .entry-editor")];

  const render = (focusId) => {
    rendering = true;
    renderChecklist(card, item, { editing: true });
    rendering = false;
    view.growToContent(item.id);

    const target = focusId === "title"
      ? card.querySelector(".checklist-title-editor")
      : fields().find((field) => field.dataset.entryId === focusId);

    if (target) {
      focusEnd(target);
    }
  };

  const add = () => {
    if (item.data.entries.length >= MAX_ENTRIES) {
      return null;
    }

    const entry = { id: crypto.randomUUID(), text: "", done: false };
    item.data.entries = addEntry(item.data.entries, entry);
    return entry.id;
  };

  const addAndFocus = () => {
    const id = add();

    if (id) {
      render(id);
      view.emit([item.id]);
    }
  };

  const onInput = (event) => {
    const target = event.target;

    if (target.classList.contains("checklist-title-editor")) {
      item.data.title = oneLine(target.value);
    } else if (target.classList.contains("entry-editor")) {
      const entry = item.data.entries.find((candidate) => candidate.id === target.dataset.entryId);

      if (entry) {
        entry.text = oneLine(target.value);
      }
    }

    view.emit([item.id]);
  };

  const onKeyDown = (event) => {
    const target = event.target;

    if (!target.classList?.contains("card-editor")) {
      return;
    }

    const list = fields();
    const index = list.indexOf(target);

    if (event.key === "Escape") {
      event.preventDefault();
      view.finishEditing();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const next = list[index + (event.key === "ArrowUp" ? -1 : 1)];

      if (next) {
        event.preventDefault();
        focusEnd(next);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();

      if (target.classList.contains("checklist-title-editor") && list[1]) {
        focusEnd(list[1]);
      } else {
        addAndFocus();
      }
    } else if (event.key === "Backspace" && target.classList.contains("entry-editor") && !target.value) {
      event.preventDefault();

      const previous = list[index - 1];
      item.data.entries = removeEntry(item.data.entries, target.dataset.entryId);
      render(previous?.dataset.entryId ?? "title");
      view.emit([item.id]);
    }
  };

  card.addEventListener("input", onInput);
  card.addEventListener("keydown", onKeyDown);
  const stop = onFocusLeave(view, card, () => rendering);

  const firstFocus = appendEntry ? add() : focusEntryId;
  render(firstFocus ?? "title");

  return {
    addEntry: addAndFocus,

    // After a tick or untick while editing: rebuild, keeping the focus.
    rerender() {
      const active = document.activeElement;
      const focusId = active?.classList.contains("checklist-title-editor") ? "title" : active?.dataset?.entryId;
      render(focusId ?? null);
    },

    finish() {
      card.removeEventListener("input", onInput);
      card.removeEventListener("keydown", onKeyDown);
      stop();

      item.data.title = item.data.title.trim();
      item.data.entries = item.data.entries
        .map((entry) => ({ ...entry, text: entry.text.trim() }))
        .filter((entry) => entry.text);

      return !(fresh && !item.data.title && !item.data.entries.length);
    }
  };
}

export function startEditor(view, item, card, options) {
  switch (item.type) {
    case "note":
      return noteEditor(view, item, card, options);
    case "checklist":
      return checklistEditor(view, item, card, options);
    case "link":
      return linkEditor(view, item, card, options);
    case "image":
      return lineEditor(view, item, card, {
        anchor: card.querySelector(".image-caption"),
        className: "caption-editor",
        label: "Image caption",
        maxLength: MAX_CAPTION_LENGTH,
        field: "caption",
        required: false
      });
    case "section":
      return lineEditor(view, item, card, {
        anchor: card.querySelector(".section-title"),
        className: "section-title-editor",
        label: "Section title",
        maxLength: MAX_TITLE_LENGTH,
        field: "title",
        required: false,
        selectAll: options.fresh
      });
    case "folder":
      return lineEditor(view, item, card, {
        anchor: card.querySelector(".folder-name"),
        className: "folder-name-editor",
        label: "Folder name",
        maxLength: MAX_TITLE_LENGTH,
        field: "name",
        required: true,
        selectAll: options.selectAll
      });
    default:
      return { finish: () => true };
  }
}
