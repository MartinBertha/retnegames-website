// Export and import of the hub's structure (docs/hub-spec.md, section 5).
// The export holds boards and cards; images are referenced by fileId and stay
// in R2. An import never overwrites anything: every board and card gets a new
// id, and the exported tree lands in a new folder under Home.

import { HttpError, json, readJson } from "./http.js";
import { cleanName, isPlainObject, isUuid, validateItem } from "./validate.js";

const FORMAT = "retne-hub-export";
const VERSION = 1;
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_IMPORT_BOARDS = 1_000;
const MAX_IMPORT_ITEMS = 50_000;
const MAX_ITEMS_PER_BOARD = 2_000;
const MAX_VIEW_COORDINATE = 2_000_000;
// Items per INSERT statement: keeps each bound JSON parameter well under 2 MB.
const ITEMS_PER_STATEMENT = 400;
const FOLDER_SIZE = { w: 160, h: 150 };
const GAP = 40;

function invalid(message) {
  throw new HttpError(400, message);
}

const finite = (value, min, max, fallback) => (
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback
);

// GET /export
export async function exportAll({ env }) {
  const [boards, items, files] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, parent_id, name, view_x, view_y, view_zoom
       FROM boards WHERE deleted_at IS NULL ORDER BY created_at, id`
    ),
    env.DB.prepare(
      `SELECT items.id, items.board_id, items.type, items.x, items.y, items.w, items.h,
              items.z, items.color, items.data
       FROM items JOIN boards ON boards.id = items.board_id
       WHERE items.deleted_at IS NULL AND boards.deleted_at IS NULL
       ORDER BY items.board_id, items.z, items.id`
    ),
    env.DB.prepare(
      `SELECT id, mime, size, width, height FROM files
       WHERE id IN (
         SELECT json_extract(data, '$.fileId') FROM items
         WHERE type = 'image' AND deleted_at IS NULL
       )`
    )
  ]);

  const exportedAt = new Date().toISOString();
  const body = {
    format: FORMAT,
    version: VERSION,
    exportedAt,
    boards: boards.results.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      name: row.name,
      viewX: row.view_x,
      viewY: row.view_y,
      viewZoom: row.view_zoom
    })),
    items: items.results.map((row) => ({
      id: row.id,
      boardId: row.board_id,
      type: row.type,
      x: row.x,
      y: row.y,
      w: row.w,
      h: row.h,
      z: row.z,
      color: row.color,
      data: JSON.parse(row.data)
    })),
    files: files.results
  };

  return json(body, 200, {
    "content-disposition": `attachment; filename="retne-hub-${exportedAt.slice(0, 10)}.json"`
  });
}

// Checks the export's boards and returns them keyed by id, the export's root
// first. Boards whose parent is missing hang off the root.
function readBoards(raw) {
  const boards = new Map();
  let root = null;

  for (const board of raw) {
    if (!isPlainObject(board) || !isUuid(board.id) || boards.has(board.id)) {
      invalid("The export contains an invalid board.");
    }

    const entry = {
      id: board.id,
      parentId: isUuid(board.parentId) ? board.parentId : null,
      name: cleanName(board.name),
      viewX: finite(board.viewX, -MAX_VIEW_COORDINATE, MAX_VIEW_COORDINATE, 0),
      viewY: finite(board.viewY, -MAX_VIEW_COORDINATE, MAX_VIEW_COORDINATE, 0),
      viewZoom: finite(board.viewZoom, 0.1, 4, 1)
    };

    if (entry.parentId === null) {
      if (root) {
        invalid("The export has more than one top-level board.");
      }

      root = entry;
    }

    boards.set(entry.id, entry);
  }

  if (!root) {
    invalid("The export has no top-level board.");
  }

  for (const board of boards.values()) {
    if (board !== root && !boards.has(board.parentId)) {
      board.parentId = root.id;
    }
  }

  // Every board must lead back to the root (no loops).
  for (const board of boards.values()) {
    let current = board;

    for (let depth = 0; current !== root; depth++) {
      if (depth > boards.size) {
        invalid("The export's boards form a loop.");
      }

      current = boards.get(current.parentId);
    }
  }

  return { boards, root };
}

// POST /import: the body is a file made by GET /export.
export async function importExport({ request, env }) {
  const body = await readJson(request, MAX_IMPORT_BYTES);

  if (
    !isPlainObject(body)
    || body.format !== FORMAT
    || body.version !== VERSION
    || !Array.isArray(body.boards)
    || !Array.isArray(body.items)
  ) {
    invalid("This file isn't a retne hub export.");
  }

  if (body.boards.length > MAX_IMPORT_BOARDS || body.items.length > MAX_IMPORT_ITEMS) {
    invalid("The export is too large to import.");
  }

  const { boards, root } = readBoards(body.boards);
  const items = [];
  const perBoard = new Map();

  for (const raw of body.items) {
    if (!isPlainObject(raw) || !boards.has(raw.boardId)) {
      invalid("The export contains a card without a board.");
    }

    const item = validateItem(raw);
    const count = (perBoard.get(raw.boardId) ?? 0) + 1;

    if (count > MAX_ITEMS_PER_BOARD) {
      invalid("A board in the export has more than 2,000 cards.");
    }

    perBoard.set(raw.boardId, count);
    items.push({ ...item, boardId: raw.boardId });
  }

  // Image cards only come along if their file is in this hub's storage.
  const fileIds = [...new Set(items.filter((item) => item.type === "image").map((item) => item.data.fileId))];
  const [rootResult, existingFiles] = await env.DB.batch([
    env.DB.prepare(
      `SELECT boards.id,
              (SELECT MIN(x) FROM items WHERE board_id = boards.id AND deleted_at IS NULL) AS min_x,
              (SELECT MAX(y + h) FROM items WHERE board_id = boards.id AND deleted_at IS NULL) AS max_y,
              (SELECT MAX(z) FROM items WHERE board_id = boards.id AND deleted_at IS NULL) AS max_z
       FROM boards WHERE parent_id IS NULL AND deleted_at IS NULL`
    ),
    env.DB.prepare("SELECT id FROM files WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(fileIds))
  ]);

  const home = rootResult.results[0];

  if (!home) {
    throw new HttpError(409, "The Home board doesn't exist yet. Open the hub once, then import.");
  }

  const knownFiles = new Set(existingFiles.results.map((row) => row.id));
  const kept = items.filter((item) => item.type !== "image" || knownFiles.has(item.data.fileId));
  const skippedImages = items.length - kept.length;

  // New ids for everything. Folder cards point at their board's new id; a
  // folder whose board is missing (or already taken) gets a new empty board.
  const newIds = new Map([...boards.keys()].map((id) => [id, crypto.randomUUID()]));
  const linked = new Set();
  const newBoards = [];

  for (const item of kept) {
    item.id = crypto.randomUUID();

    if (item.type === "folder") {
      const child = item.data.childBoardId;

      if (boards.has(child) && child !== root.id && !linked.has(child) && boards.get(child).parentId === item.boardId) {
        linked.add(child);
        item.data.childBoardId = newIds.get(child);
      } else {
        const id = crypto.randomUUID();
        newBoards.push({ id, parentId: newIds.get(item.boardId), name: item.data.name, viewX: 0, viewY: 0, viewZoom: 1 });
        item.data.childBoardId = id;
      }
    }
  }

  // Boards that no folder card opened get one, below their parent's cards.
  for (const board of boards.values()) {
    if (board === root || linked.has(board.id)) {
      continue;
    }

    const siblings = kept.filter((item) => item.boardId === board.parentId);
    const bottom = siblings.reduce((max, item) => Math.max(max, item.y + item.h), 0);
    const index = (perBoard.get(board.parentId) ?? 0) + 1;

    perBoard.set(board.parentId, index);

    if (index > MAX_ITEMS_PER_BOARD) {
      invalid("A board in the export has more than 2,000 cards.");
    }

    kept.push({
      id: crypto.randomUUID(),
      boardId: board.parentId,
      type: "folder",
      x: (index % 6) * (FOLDER_SIZE.w + GAP),
      y: bottom + GAP,
      w: FOLDER_SIZE.w,
      h: FOLDER_SIZE.h,
      z: index,
      color: null,
      data: { name: board.name, childBoardId: newIds.get(board.id) }
    });
  }

  const now = Date.now();
  const importId = newIds.get(root.id);
  const importName = `Imported ${new Date(now).toISOString().slice(0, 10)}`;

  const boardRows = [
    ...[...boards.values()].map((board) => ({
      id: newIds.get(board.id),
      parentId: board === root ? home.id : newIds.get(board.parentId),
      name: board === root ? importName : board.name,
      viewX: board.viewX,
      viewY: board.viewY,
      viewZoom: board.viewZoom
    })),
    ...newBoards
  ];

  const itemRows = kept.map((item) => ({
    id: item.id,
    boardId: newIds.get(item.boardId),
    type: item.type,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
    z: item.z,
    color: item.color,
    data: JSON.stringify(item.data)
  }));

  // The folder card on Home, below what's there already.
  itemRows.push({
    id: crypto.randomUUID(),
    boardId: home.id,
    type: "folder",
    x: home.min_x ?? 0,
    y: (home.max_y ?? 0) + GAP,
    w: FOLDER_SIZE.w,
    h: FOLDER_SIZE.h,
    z: (home.max_z ?? 0) + 1,
    color: null,
    data: JSON.stringify({ name: importName, childBoardId: importId })
  });

  const statements = [
    env.DB.prepare(
      `INSERT INTO boards (id, parent_id, name, view_x, view_y, view_zoom, created_at, updated_at)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.parentId'), json_extract(value, '$.name'),
              json_extract(value, '$.viewX'), json_extract(value, '$.viewY'), json_extract(value, '$.viewZoom'),
              ?1, ?1
       FROM json_each(?2)`
    ).bind(now, JSON.stringify(boardRows))
  ];

  for (let start = 0; start < itemRows.length; start += ITEMS_PER_STATEMENT) {
    statements.push(env.DB.prepare(
      `INSERT INTO items (id, board_id, type, x, y, w, h, z, color, data, created_at, updated_at)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.boardId'), json_extract(value, '$.type'),
              json_extract(value, '$.x'), json_extract(value, '$.y'),
              json_extract(value, '$.w'), json_extract(value, '$.h'),
              json_extract(value, '$.z'), json_extract(value, '$.color'),
              json_extract(value, '$.data'), ?1, ?1
       FROM json_each(?2)`
    ).bind(now, JSON.stringify(itemRows.slice(start, start + ITEMS_PER_STATEMENT))));
  }

  statements.push(env.DB.prepare(
    "UPDATE boards SET rev = rev + 1, updated_at = ?2 WHERE id = ?1"
  ).bind(home.id, now));

  await env.DB.batch(statements);

  return json({
    boardId: importId,
    name: importName,
    boards: boardRows.length,
    cards: itemRows.length - 1,
    skippedImages
  }, 201);
}
