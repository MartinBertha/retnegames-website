// Hub API under /hub/api (docs/hub-spec.md, section 5): boards, card changes
// and images (files.js).
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
    // Keep the folder card in the parent board in sync with the board name.
    statements.push(
      env.DB.prepare(
        `UPDATE boards SET rev = rev + 1, updated_at = ?2
         WHERE id = (SELECT parent_id FROM boards WHERE id = ?1 AND deleted_at IS NULL)
           AND EXISTS (
             SELECT 1 FROM items
             WHERE items.board_id = boards.id AND items.type = 'folder'
               AND items.deleted_at IS NULL
               AND json_extract(items.data, '$.childBoardId') = ?1
           )`
      ).bind(id, now),
      env.DB.prepare(
        `UPDATE items SET data = json_set(data, '$.name', ?2), updated_at = ?3
         WHERE type = 'folder' AND deleted_at IS NULL
           AND board_id = (SELECT parent_id FROM boards WHERE id = ?1 AND deleted_at IS NULL)
           AND json_extract(data, '$.childBoardId') = ?1`
      ).bind(id, name, now)
    );
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

// Soft-deletes a (non-root) board and all its live descendants, stamped with
// one deleted_at so restoreSubtree can bring back exactly that set.
function deleteSubtree(env, boardId, now) {
  return env.DB.prepare(
    `WITH RECURSIVE subtree(id, depth) AS (
       SELECT id, 0 FROM boards
       WHERE id = ?1 AND deleted_at IS NULL AND parent_id IS NOT NULL
       UNION ALL
       SELECT b.id, s.depth + 1
       FROM boards b JOIN subtree s ON b.parent_id = s.id
       WHERE b.deleted_at IS NULL AND s.depth < 1000
     )
     UPDATE boards SET deleted_at = ?2, updated_at = ?2
     WHERE id IN (SELECT id FROM subtree)`
  ).bind(boardId, now);
}

// Undoes deleteSubtree: restores the board and the descendants deleted with it.
function restoreSubtree(env, boardId, deletedAt, now) {
  return env.DB.prepare(
    `WITH RECURSIVE subtree(id, depth) AS (
       SELECT id, 0 FROM boards WHERE id = ?1 AND deleted_at = ?2
       UNION ALL
       SELECT b.id, s.depth + 1
       FROM boards b JOIN subtree s ON b.parent_id = s.id
       WHERE b.deleted_at = ?2 AND s.depth < 1000
     )
     UPDATE boards SET deleted_at = NULL, updated_at = ?3
     WHERE id IN (SELECT id FROM subtree)`
  ).bind(boardId, deletedAt, now);
}

// DELETE /boards/:id. Soft-deletes the board, its descendants and its folder card.
async function deleteBoard({ env, params }) {
  const id = boardIdParam(params[0]);

  const board = await env.DB.prepare(
    "SELECT parent_id FROM boards WHERE id = ?1 AND deleted_at IS NULL"
  ).bind(id).first();

  if (!board) {
    throw new HttpError(404, "Board not found.");
  }

  if (board.parent_id === null) {
    throw new HttpError(400, "The Home board can't be deleted.");
  }

  const now = Date.now();

  await env.DB.batch([
    deleteSubtree(env, id, now),
    env.DB.prepare(
      `UPDATE items SET deleted_at = ?3, updated_at = ?3
       WHERE board_id = ?2 AND type = 'folder' AND deleted_at IS NULL
         AND json_extract(data, '$.childBoardId') = ?1`
    ).bind(id, board.parent_id, now),
    env.DB.prepare(
      "UPDATE boards SET rev = rev + 1, updated_at = ?2 WHERE id = ?1"
    ).bind(board.parent_id, now)
  ]);

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

  const childList = [...upserts.values()]
    .filter((item) => item.type === "folder")
    .map((item) => item.data.childBoardId);

  if (new Set(childList).size !== childList.length) {
    throw new HttpError(409, "That folder's board is already used by another card.");
  }

  const ids = JSON.stringify([...upserts.keys(), ...deletes]);
  const childIds = JSON.stringify(childList);
  const fileIds = [...new Set(
    [...upserts.values()].filter((item) => item.type === "image").map((item) => item.data.fileId)
  )];

  const [boardResult, existingResult, countResult, childResult, linkResult, fileResult] = await env.DB.batch([
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
      `SELECT id, parent_id, deleted_at
       FROM boards WHERE id IN (SELECT value FROM json_each(?1))`
    ).bind(childIds),
    env.DB.prepare(
      `SELECT id, json_extract(data, '$.childBoardId') AS child_id
       FROM items
       WHERE type = 'folder' AND deleted_at IS NULL
         AND json_extract(data, '$.childBoardId') IN (SELECT value FROM json_each(?1))`
    ).bind(childIds),
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

  // A child board belongs to exactly one live folder card.
  for (const link of linkResult.results) {
    const item = upserts.get(link.id);

    if (item?.data.childBoardId !== link.child_id && !deletes.has(link.id)) {
      throw new HttpError(409, "That folder's board is already used by another card.");
    }
  }

  const children = new Map(childResult.results.map((row) => [row.id, row]));
  const now = Date.now();
  const statements = [];

  for (const item of upserts.values()) {
    if (item.type !== "folder") {
      continue;
    }

    const { childBoardId, name } = item.data;
    const child = children.get(childBoardId);

    if (!child) {
      statements.push(env.DB.prepare(
        `INSERT INTO boards (id, parent_id, name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)`
      ).bind(childBoardId, boardId, name, now));
      continue;
    }

    if (child.parent_id !== boardId) {
      throw new HttpError(409, "That folder's board belongs elsewhere.");
    }

    if (child.deleted_at !== null) {
      statements.push(restoreSubtree(env, childBoardId, child.deleted_at, now));
    }

    statements.push(env.DB.prepare(
      `UPDATE boards SET name = ?2, rev = rev + 1, updated_at = ?3
       WHERE id = ?1 AND name <> ?2`
    ).bind(childBoardId, name, now));
  }

  for (const id of deletions) {
    const row = existing.get(id);
    const childBoardId = row.type === "folder" ? parseJson(row.data)?.childBoardId : null;

    if (isUuid(childBoardId)) {
      statements.push(deleteSubtree(env, childBoardId, now));
    }
  }

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

const ROUTES = [
  { pattern: /^\/boards$/, methods: { GET: listBoards, POST: createBoard } },
  { pattern: /^\/boards\/([^/]+)$/, methods: { GET: getBoard, PATCH: updateBoard, DELETE: deleteBoard } },
  { pattern: /^\/boards\/([^/]+)\/rev$/, methods: { GET: getBoardRev } },
  { pattern: /^\/boards\/([^/]+)\/changes$/, methods: { POST: applyChanges } },
  { pattern: /^\/files$/, methods: { POST: uploadFile } },
  { pattern: /^\/files\/([^/]+)$/, methods: { GET: getFile } }
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
