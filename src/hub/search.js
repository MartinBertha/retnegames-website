// The search index (docs/hub-spec.md, section 5 "Search"): every live board,
// and the words of every live card on a live board, for the client to search
// as you type (public/hub/search.js). SQLite pulls the words out of each
// card's JSON, so the Worker doesn't parse every card.

import { json } from "./http.js";

// GET /index
export async function searchIndex({ env }) {
  const [boards, items] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, parent_id, name, updated_at
       FROM boards WHERE deleted_at IS NULL
       ORDER BY created_at, id`
    ),
    env.DB.prepare(
      `SELECT items.id, items.board_id, items.type, items.updated_at,
              CASE items.type
                WHEN 'note' THEN json_extract(items.data, '$.title')
                WHEN 'checklist' THEN json_extract(items.data, '$.title')
                WHEN 'image' THEN json_extract(items.data, '$.caption')
                WHEN 'link' THEN json_extract(items.data, '$.title')
                WHEN 'section' THEN json_extract(items.data, '$.title')
                WHEN 'folder' THEN json_extract(items.data, '$.name')
              END AS title,
              CASE items.type
                WHEN 'note' THEN json_extract(items.data, '$.text')
                WHEN 'checklist' THEN (
                  SELECT group_concat(json_extract(entry.value, '$.text'), char(10))
                  FROM json_each(items.data, '$.entries') AS entry
                )
                WHEN 'link' THEN json_extract(items.data, '$.url')
              END AS body,
              CASE items.type
                WHEN 'image' THEN json_extract(items.data, '$.fileId')
                WHEN 'folder' THEN json_extract(items.data, '$.childBoardId')
              END AS ref
       FROM items JOIN boards ON boards.id = items.board_id
       WHERE items.deleted_at IS NULL AND boards.deleted_at IS NULL
         AND items.type <> 'connector'
       ORDER BY items.board_id, items.z, items.id`
    )
  ]);

  return json({
    rootId: boards.results.find((row) => row.parent_id === null)?.id ?? null,
    boards: boards.results.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      name: row.name,
      updatedAt: row.updated_at
    })),
    items: items.results.map((row) => ({
      id: row.id,
      boardId: row.board_id,
      type: row.type,
      title: row.title ?? "",
      body: row.body ?? "",
      ref: row.ref ?? null,
      updatedAt: row.updated_at
    }))
  });
}
