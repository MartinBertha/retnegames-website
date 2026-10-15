// Hub API under /hub/api (docs/hub-spec.md, section 5): boards, card changes,
// images (files.js), and export and import (transfer.js).
// All SQL uses prepared statements with bound parameters.

import {
  HttpError,
  checkJsonContentType,
  checkSameOrigin,
  errorJson,
  isMutation,
  json,
  readJson
} from "./http.js";
import { getFile, uploadFile } from "./files.js";
import { boardsToDelete, boardsToRestore, hasLiveLink, loadGraph, reachable } from "./folders.js";
import { exportAll, importExport } from "./transfer.js";
import { cleanName, isPlainObject, isUuid, validateItem } from "./validate.js";

const ROOT_BOARD_NAME = "Home";
const MAX_SMALL_BODY_BYTES = 4 * 1024;
const MAX_CHANGES_BODY_BYTES = 256 * 1024;
const MAX_OPS_PER_REQUEST = 100;
const MAX_ITEMS_PER_BOARD = 2_000;
const MAX_VIEW_COORDINATE = 2_000_000;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

function boardIdParam(value) {
  if (!isUuid(value)) {
    throw new HttpError(404, "Board not found.");
  }

  return value;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function viewNumber(value, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new HttpError(400, "Invalid view.");
  }

  return value;
}

function toBoard(row) {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    viewX: row.view_x,
    viewY: row.view_y,
    viewZoom: row.view_zoom,
    rev: row.rev,
    updatedAt: row.updated_at
  };
}

function toItem(row) {
  let data = {};

  try {
    data = JSON.parse(row.data);
  } catch {
    console.error("hub: unreadable item data", row.id);
  }

  return {
    id: row.id,
    type: row.type,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    z: row.z,
    color: row.color,
    data,
    updatedAt: row.updated_at
  };
}

function selectBoard(env, id) {
  return env.DB.prepare(
    `SELECT id, parent_id, name, view_x, view_y, view_zoom, rev, updated_at
     FROM boards WHERE id = ?1 AND deleted_at IS NULL`
  ).bind(id);
}

function selectAllBoards(env) {
  return env.DB.prepare(
    `SELECT id, parent_id, name, updated_at
     FROM boards WHERE deleted_at IS NULL
     ORDER BY created_at, id`
  );
}

// GET /boards. Creates the root board "Home" on first run.
async function listBoards({ env }) {
  let { results } = await selectAllBoards(env).all();

  if (!results.some((row) => row.parent_id === null)) {
    const now = Date.now();

    await env.DB.prepare(
      `INSERT OR IGNORE INTO boards (id, parent_id, name, created_at, updated_at)
       SELECT ?1, NULL, ?2, ?3, ?3
       WHERE NOT EXISTS (SELECT 1 FROM boards WHERE parent_id IS NULL)`
    ).bind(crypto.randomUUID(), ROOT_BOARD_NAME, now).run();

    ({ results } = await selectAllBoards(env).all());
  }

  const boards = results.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    updatedAt: row.updated_at
  }));

  return json({
    rootId: boards.find((board) => board.parentId === null)?.id ?? null,
    boards
  });
}

// GET /boards/:id. Board, its items and the breadcrumb path (root first, this board last).
async function getBoard({ env, params }) {
  const id = boardIdParam(params[0]);

  const [boardResult, pathResult, itemsResult] = await env.DB.batch([
    selectBoard(env, id),
    env.DB.prepare(
      `WITH RECURSIVE ancestors(id, parent_id, name, depth) AS (
         SELECT id, parent_id, name, 0 FROM boards WHERE id = ?1
         UNION ALL
         SELECT b.id, b.parent_id, b.name, a.depth + 1
         FROM boards b JOIN ancestors a ON b.id = a.parent_id
         WHERE a.depth < 1000
       )
       SELECT id, name FROM ancestors ORDER BY depth DESC`
    ).bind(id),
    env.DB.prepare(
      `SELECT id, type, x, y, w, h, z, color, data, updated_at
       FROM items WHERE board_id = ?1 AND deleted_at IS NULL
       ORDER BY z, id`
    ).bind(id)
  ]);

  const row = boardResult.results[0];

  if (!row) {
    throw new HttpError(404, "Board not found.");
  }

  return json({
    board: toBoard(row),
    path: pathResult.results.map(({ id: pathId, name }) => ({ id: pathId, name })),
    items: itemsResult.results.map(toItem)
  });
}

// GET /boards/:id/rev
async function getBoardRev({ env, params }) {
  const id = boardIdParam(params[0]);

  const row = await env.DB.prepare(
    "SELECT rev FROM boards WHERE id = ?1 AND deleted_at IS NULL"
  ).bind(id).first();

  if (!row) {
    throw new HttpError(404, "Board not found.");
  }

  return json({ rev: row.rev });
}

// PATCH /boards/:id { name?, viewX?, viewY?, viewZoom? }
async function updateBoard({ request, env, params }) {
  const id = boardIdParam(params[0]);
  const body = await readJson(request, MAX_SMALL_BODY_BYTES);

  if (!isPlainObject(body)) {
    throw new HttpError(400, "Invalid request.");
  }

  const fields = new Set(["name", "viewX", "viewY", "viewZoom"]);

  if (!Object.keys(body).every((key) => fields.has(key))) {
    throw new HttpError(400, "Unknown field.");
  }

  const name = body.name === undefined ? null : cleanName(body.name);
  const viewX = body.viewX === undefined
    ? null
    : viewNumber(body.viewX, -MAX_VIEW_COORDINATE, MAX_VIEW_COORDINATE);
  const viewY = body.viewY === undefined
    ? null
    : viewNumber(body.viewY, -MAX_VIEW_COORDINATE, MAX_VIEW_COORDINATE);
  const viewZoom = body.viewZoom === undefined
    ? null
    : viewNumber(body.viewZoom, MIN_ZOOM, MAX_ZOOM);

  if (name === null && viewX === null && viewY === null && viewZoom === null) {
    throw new HttpError(400, "Nothing to update.");
  }

  const now = Date.now();

  // A rename counts as a change (rev bump); a view change does not.
  const statements = [
    env.DB.prepare(
      `UPDATE boards SET
         name = COALESCE(?2, name),
         view_x = COALESCE(?3, view_x),
         view_y = COALESCE(?4, view_y),
         view_zoom = COALESCE(?5, view_zoom),
         rev = CASE WHEN ?2 IS NULL THEN rev ELSE rev + 1 END,
         updated_at = CASE WHEN ?2 IS NULL THEN updated_at ELSE ?6 END
       WHERE id = ?1 AND deleted_at IS NULL`
    ).bind(id, name, viewX, viewY, viewZoom, now)
  ];

  if (name !== null) {
    statements.push(...renameLinkStatements(env, id, name, now));
  }

  statements.push(selectBoard(env, id));

  const results = await env.DB.batch(statements);
  const row = results[results.length - 1].results[0];

  if (!row) {
    throw new HttpError(404, "Board not found.");
  }

  return json({ board: toBoard(row) });
}

// POST /boards { id, parentId, name }. Retrying the same request is safe.
async function createBoard({ request, env }) {
  const body = await readJson(request, MAX_SMALL_BODY_BYTES);

  if (!isPlainObject(body) || !isUuid(body.id) || !isUuid(body.parentId)) {
    throw new HttpError(400, "Invalid request.");
  }

  const name = cleanName(body.name);
  const now = Date.now();

  const [insertResult, selectResult] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO boards (id, parent_id, name, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?4
       WHERE EXISTS (SELECT 1 FROM boards WHERE id = ?2 AND deleted_at IS NULL)
       ON CONFLICT(id) DO NOTHING`
    ).bind(body.id, body.parentId, name, now),
    env.DB.prepare(
      `SELECT id, parent_id, name, view_x, view_y, view_zoom, rev, updated_at, deleted_at
       FROM boards WHERE id = ?1`
    ).bind(body.id)
  ]);

  const row = selectResult.results[0];

  if (insertResult.meta.changes > 0) {
    return json({ board: toBoard(row) }, 201);
  }

  if (!row) {
    throw new HttpError(404, "Parent board not found.");
  }

  if (row.parent_id === body.parentId && row.deleted_at === null) {
    return json({ board: toBoard(row) });
  }

  throw new HttpError(409, "A board with this id already exists.");
}

// DELETE /boards/:id. Removes every folder card that opens the board, then
// deletes it and the boards that only it leads to (folders.js).
async function deleteBoard({ env, params }) {
  const id = boardIdParam(params[0]);
  const graph = await loadGraph(env);
  const board = graph.boards.get(id);

  if (!board || board.deletedAt !== null) {
    throw new HttpError(404, "Board not found.");
  }

  if (board.parentId === null) {
    throw new HttpError(400, "The Home board can't be deleted.");
  }

  const now = Date.now();
  const cards = graph.links.filter((link) => link.child === id);
  const links = graph.links.filter((link) => link.child !== id);
  const rootId = [...graph.boards.values()].find((candidate) => candidate.parentId === null)?.id;
  const statements = [setDeletedStatement(env, boardsToDelete(graph, id, links, rootId), now)];

  if (cards.length) {
    statements.push(
      env.DB.prepare(
        `UPDATE items SET deleted_at = ?2, updated_at = ?2
         WHERE id IN (SELECT value FROM json_each(?1))`
      ).bind(JSON.stringify(cards.map((card) => card.id)), now),
      env.DB.prepare(
        `UPDATE boards SET rev = rev + 1, updated_at = ?2
         WHERE id IN (SELECT value FROM json_each(?1))`
      ).bind(JSON.stringify([...new Set(cards.map((card) => card.boardId))]), now)
    );
  }

  await env.DB.batch(statements);
  return json({ ok: true });
}

function parseOps(body) {
  if (
    !isPlainObject(body)
    || !Array.isArray(body.ops)
    || body.ops.length === 0
    || body.ops.length > MAX_OPS_PER_REQUEST
  ) {
    throw new HttpError(400, `Send 1 to ${MAX_OPS_PER_REQUEST} changes.`);
  }

  const upserts = new Map();
  const deletes = new Set();

  for (const op of body.ops) {
    let id;

    if (op?.op === "upsert") {
      const item = validateItem(op.item);
      id = item.id;

      if (upserts.has(id) || deletes.has(id)) {
        throw new HttpError(400, "The same card appears twice.");
      }

      upserts.set(id, item);
    } else if (op?.op === "delete" && isUuid(op.id)) {
      id = op.id;

      if (upserts.has(id) || deletes.has(id)) {
        throw new HttpError(400, "The same card appears twice.");
      }

      deletes.add(id);
    } else {
      throw new HttpError(400, "Invalid change.");
    }
  }

  return { upserts, deletes };
}

// POST /boards/:id/changes { ops: [{ op: "upsert", item }, { op: "delete", id }] }
// One D1 batch (a transaction). Per-card last write wins; bumps the board's rev.
// Folder cards keep their child board in step: created, renamed, deleted and
// restored together with the card.
async function applyChanges({ request, env, params }) {
  const boardId = boardIdParam(params[0]);
  const { upserts, deletes } = parseOps(await readJson(request, MAX_CHANGES_BODY_BYTES));

  const ids = JSON.stringify([...upserts.keys(), ...deletes]);
  const fileIds = [...new Set(
    [...upserts.values()].filter((item) => item.type === "image").map((item) => item.data.fileId)
  )];

  const [boardResult, existingResult, countResult, fileResult] = await env.DB.batch([
    env.DB.prepare(
      "SELECT id FROM boards WHERE id = ?1 AND deleted_at IS NULL"
    ).bind(boardId),
    env.DB.prepare(
      `SELECT id, board_id, type, data, deleted_at
       FROM items WHERE id IN (SELECT value FROM json_each(?1))`
    ).bind(ids),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM items WHERE board_id = ?1 AND deleted_at IS NULL"
    ).bind(boardId),
    env.DB.prepare(
      "SELECT id FROM files WHERE id IN (SELECT value FROM json_each(?1))"
    ).bind(JSON.stringify(fileIds))
  ]);

  if (!boardResult.results.length) {
    throw new HttpError(404, "Board not found.");
  }

  if (fileResult.results.length !== fileIds.length) {
    throw new HttpError(400, "Image not found. Upload it first.");
  }

  const existing = new Map(existingResult.results.map((row) => [row.id, row]));
  let liveCount = countResult.results[0].count;

  for (const item of upserts.values()) {
    const row = existing.get(item.id);

    if (row && row.board_id !== boardId) {
      throw new HttpError(409, "That card belongs to another board.");
    }

    if (row && row.type !== item.type) {
      throw new HttpError(400, "A card's type can't change.");
    }

    if (
      row
      && item.type === "folder"
      && parseJson(row.data)?.childBoardId !== item.data.childBoardId
    ) {
      throw new HttpError(400, "A folder's board can't change.");
    }

    if (!row || row.deleted_at !== null) {
      liveCount++;
    }
  }

  // Deleting a card that is already gone (or never saved) is a no-op.
  const deletions = [...deletes].filter((id) => {
    const row = existing.get(id);
    return row && row.board_id === boardId && row.deleted_at === null;
  });

  liveCount -= deletions.length;

  if (liveCount > MAX_ITEMS_PER_BOARD) {
    throw new HttpError(400, `A board can hold at most ${MAX_ITEMS_PER_BOARD.toLocaleString("en")} cards.`);
  }

  const now = Date.now();
  const statements = await folderStatements(env, {
    boardId,
    upserts,
    deletedRows: deletions.map((id) => existing.get(id)),
    existing,
    now
  });

  if (upserts.size) {
    const rows = [...upserts.values()].map(({ id, type, x, y, w, h, z, color, dataJson }) => (
      { id, type, x, y, w, h, z, color, data: dataJson }
    ));

    statements.push(env.DB.prepare(
      `INSERT INTO items (id, board_id, type, x, y, w, h, z, color, data, created_at, updated_at, deleted_at)
       SELECT json_extract(value, '$.id'), ?1, json_extract(value, '$.type'),
              json_extract(value, '$.x'), json_extract(value, '$.y'),
              json_extract(value, '$.w'), json_extract(value, '$.h'),
              json_extract(value, '$.z'), json_extract(value, '$.color'),
              json_extract(value, '$.data'), ?2, ?2, NULL
       FROM json_each(?3) WHERE true
       ON CONFLICT(id) DO UPDATE SET
         x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
         z = excluded.z, color = excluded.color, data = excluded.data,
         updated_at = excluded.updated_at, deleted_at = NULL
       WHERE items.board_id = excluded.board_id`
    ).bind(boardId, now, JSON.stringify(rows)));
  }

  if (deletions.length) {
    statements.push(env.DB.prepare(
      `UPDATE items SET deleted_at = ?2, updated_at = ?2
       WHERE board_id = ?1 AND deleted_at IS NULL
         AND id IN (SELECT value FROM json_each(?3))`
    ).bind(boardId, now, JSON.stringify(deletions)));
  }

  statements.push(
    env.DB.prepare(
      "UPDATE boards SET rev = rev + 1, updated_at = ?2 WHERE id = ?1"
    ).bind(boardId, now),
    env.DB.prepare("SELECT rev FROM boards WHERE id = ?1").bind(boardId)
  );

  const results = await env.DB.batch(statements);

  return json({ rev: results[results.length - 1].results[0].rev });
}

// Renaming a board renames every folder card that opens it, wherever it is,
// and bumps those boards' rev so other devices pick it up.
function renameLinkStatements(env, childBoardId, name, now, skipItemIds = []) {
  const skip = JSON.stringify(skipItemIds);

  return [
    env.DB.prepare(
      `UPDATE boards SET rev = rev + 1, updated_at = ?3
       WHERE id IN (
         SELECT board_id FROM items
         WHERE type = 'folder' AND deleted_at IS NULL
           AND json_extract(data, '$.childBoardId') = ?1
           AND json_extract(data, '$.name') <> ?2
           AND id NOT IN (SELECT value FROM json_each(?4))
       )`
    ).bind(childBoardId, name, now, skip),
    env.DB.prepare(
      `UPDATE items SET data = json_set(data, '$.name', ?2), updated_at = ?3
       WHERE type = 'folder' AND deleted_at IS NULL
         AND json_extract(data, '$.childBoardId') = ?1
         AND json_extract(data, '$.name') <> ?2
         AND id NOT IN (SELECT value FROM json_each(?4))`
    ).bind(childBoardId, name, now, skip)
  ];
}

function setDeletedStatement(env, boardIds, now) {
  return env.DB.prepare(
    `UPDATE boards SET deleted_at = ?1, updated_at = ?1
     WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?2))`
  ).bind(now, JSON.stringify([...boardIds]));
}

// What folder cards in a change do to boards (folders.js). A new folder
// creates its board; a pasted or moved folder card opens an existing board,
// which is restored if it was deleted and moves its home here when the card
// that held it is gone. A folder may not end up inside itself. Deleting a
// folder's last card deletes its board and what only that board leads to.
async function folderStatements(env, { boardId, upserts, deletedRows, existing, now }) {
  const folders = [...upserts.values()].filter((item) => item.type === "folder");
  const deletedFolders = deletedRows.filter((row) => row.type === "folder");

  if (!folders.length && !deletedFolders.length) {
    return [];
  }

  const graph = await loadGraph(env);
  const rootId = [...graph.boards.values()].find((board) => board.parentId === null && board.deletedAt === null)?.id;
  const changedCards = new Set([...deletedRows.map((row) => row.id), ...folders.map((item) => item.id)]);
  const links = [
    ...graph.links.filter((link) => !changedCards.has(link.id)),
    ...folders.map((item) => ({ id: item.id, boardId, child: item.data.childBoardId }))
  ];
  const statements = [];
  const restored = new Set();
  const rehomed = new Set();
  const renamed = new Map();

  for (const item of folders) {
    const { childBoardId, name } = item.data;
    const child = graph.boards.get(childBoardId);

    if (!child) {
      statements.push(env.DB.prepare(
        `INSERT INTO boards (id, parent_id, name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)`
      ).bind(childBoardId, boardId, name, now));
      graph.boards.set(childBoardId, { id: childBoardId, parentId: boardId, name, deletedAt: null });
      continue;
    }

    for (const id of boardsToRestore(graph, childBoardId, links)) {
      graph.boards.get(id).deletedAt = null;
      restored.add(id);
    }

    // A pasted card takes the board's current name (it may have been copied
    // before a rename); renaming an existing card renames the board.
    const row = existing.get(item.id);

    if (!row || row.deleted_at !== null) {
      item.data.name = child.name;
      item.dataJson = JSON.stringify(item.data);
    } else if (child.name !== name) {
      renamed.set(childBoardId, name);
    }
  }

  for (const item of folders) {
    const childBoardId = item.data.childBoardId;
    const row = existing.get(item.id);
    const newCard = !row || row.deleted_at !== null;

    if (newCard && (childBoardId === rootId || reachable(graph, childBoardId, links).has(boardId))) {
      throw new HttpError(409, "A folder can't go inside itself.");
    }

    const child = graph.boards.get(childBoardId);
    const homeStillHasCard = links.some((link) => link.child === childBoardId && link.boardId === child.parentId);

    if (child.parentId !== boardId && !homeStillHasCard) {
      rehomed.add(childBoardId);
    }
  }

  const doomed = new Set();

  for (const row of deletedFolders) {
    const childBoardId = parseJson(row.data)?.childBoardId;

    if (isUuid(childBoardId) && !hasLiveLink(graph, childBoardId, links)) {
      for (const id of boardsToDelete(graph, childBoardId, links, rootId)) {
        graph.boards.get(id).deletedAt = now;
        doomed.add(id);
      }
    }
  }

  if (restored.size) {
    statements.push(env.DB.prepare(
      `UPDATE boards SET deleted_at = NULL, updated_at = ?1
       WHERE id IN (SELECT value FROM json_each(?2))`
    ).bind(now, JSON.stringify([...restored])));
  }

  if (rehomed.size) {
    statements.push(env.DB.prepare(
      `UPDATE boards SET parent_id = ?1, updated_at = ?2
       WHERE id IN (SELECT value FROM json_each(?3))`
    ).bind(boardId, now, JSON.stringify([...rehomed])));
  }

  for (const [childBoardId, name] of renamed) {
    statements.push(
      env.DB.prepare(
        "UPDATE boards SET name = ?2, rev = rev + 1, updated_at = ?3 WHERE id = ?1"
      ).bind(childBoardId, name, now),
      ...renameLinkStatements(env, childBoardId, name, now, [...upserts.keys()])
    );
  }

  if (doomed.size) {
    statements.push(setDeletedStatement(env, doomed, now));
  }

  return statements;
}

const ROUTES = [
  { pattern: /^\/boards$/, methods: { GET: listBoards, POST: createBoard } },
  { pattern: /^\/boards\/([^/]+)$/, methods: { GET: getBoard, PATCH: updateBoard, DELETE: deleteBoard } },
  { pattern: /^\/boards\/([^/]+)\/rev$/, methods: { GET: getBoardRev } },
  { pattern: /^\/boards\/([^/]+)\/changes$/, methods: { POST: applyChanges } },
  { pattern: /^\/files$/, methods: { POST: uploadFile } },
  { pattern: /^\/files\/([^/]+)$/, methods: { GET: getFile } },
  { pattern: /^\/export$/, methods: { GET: exportAll } },
  { pattern: /^\/import$/, methods: { POST: importExport } }
];

export async function handleApi(request, env, url) {
  try {
    const path = url.pathname.slice("/hub/api".length);

    // Every change needs the hub's own Origin. Bodies are JSON, except image
    // uploads, which uploadFile checks itself.
    if (isMutation(request.method)) {
      checkSameOrigin(request, url);

      if (!(request.method === "POST" && path === "/files")) {
        checkJsonContentType(request);
      }
    }

    for (const route of ROUTES) {
      const match = route.pattern.exec(path);

      if (!match) {
        continue;
      }

      if (!Object.hasOwn(route.methods, request.method)) {
        return errorJson(405, "Method not allowed.", {
          allow: Object.keys(route.methods).join(", ")
        });
      }

      return await route.methods[request.method]({
        request,
        env,
        url,
        params: match.slice(1)
      });
    }

    return errorJson(404, "Not found.");
  } catch (error) {
    if (error instanceof HttpError) {
      return errorJson(error.status, error.message);
    }

    console.error("hub api error:", error?.message || error);
    return errorJson(500, "Server error.");
  }
}
