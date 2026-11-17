// Recently deleted cards (docs/hub-spec.md, section 5 "Trash"). Deleting is a
// soft delete, so a deleted card can be restored by saving it again through
// /boards/:id/changes; restoring a folder card brings its board back with it.
// Only cards on boards that still exist are listed: cards on a deleted board
// come back with that board.

import { json } from "./http.js";

const MAX_ENTRIES = 300;

function parseData(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// GET /trash. Newest first.
export async function listTrash({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT items.id, items.board_id, boards.name AS board_name, items.type,
            items.x, items.y, items.w, items.h, items.z, items.color, items.data,
            items.deleted_at
     FROM items JOIN boards ON boards.id = items.board_id
     WHERE items.deleted_at IS NOT NULL AND boards.deleted_at IS NULL
     ORDER BY items.deleted_at DESC, items.id
     LIMIT ?1`
  ).bind(MAX_ENTRIES).all();

  return json({
    items: results.map((row) => ({
      item: {
        id: row.id,
        type: row.type,
        x: row.x,
        y: row.y,
        w: row.w,
        h: row.h,
        z: row.z,
        color: row.color,
        data: parseData(row.data)
      },
      boardId: row.board_id,
      boardName: row.board_name,
      deletedAt: row.deleted_at
    })),
    limit: MAX_ENTRIES
  });
}
