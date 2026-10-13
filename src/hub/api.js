// Hub API under /hub/api (docs/hub-spec.md, section 5). Boards endpoints.
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

const ROOT_BOARD_NAME = "Home";
const MAX_NAME_LENGTH = 100;
const MAX_SMALL_BODY_BYTES = 4 * 1024;
const MAX_VIEW_COORDINATE = 2_000_000;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function boardIdParam(value) {
  if (!isUuid(value)) {
    throw new HttpError(404, "Board not found.");
  }

  return value;
}

// Names are single-line plain text: control characters become spaces.
export function cleanName(value) {
  if (typeof value !== "string") {
    throw new HttpError(400, "Name must be text.");
  }

  const name = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();

  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new HttpError(400, `Name must be 1 to ${MAX_NAME_LENGTH} characters.`);
  }

  return name;
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
    env.DB.prepare(
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
    ).bind(id, now),
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

const ROUTES = [
  { pattern: /^\/boards$/, methods: { GET: listBoards, POST: createBoard } },
  { pattern: /^\/boards\/([^/]+)$/, methods: { GET: getBoard, PATCH: updateBoard, DELETE: deleteBoard } },
  { pattern: /^\/boards\/([^/]+)\/rev$/, methods: { GET: getBoardRev } }
];

export async function handleApi(request, env, url) {
  try {
    if (isMutation(request.method)) {
      checkSameOrigin(request, url);
      checkJsonContentType(request);
    }

    const path = url.pathname.slice("/hub/api".length);

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
