-- retne hub: line connectors (docs/hub-spec.md, section 4).
-- SQLite can't change a CHECK constraint in place, so the items table is
-- rebuilt with 'connector' added to the allowed types. Nothing references
-- items, and every row is copied unchanged, so it is safe to run while the
-- previous version is live (that version never writes a connector).

CREATE TABLE items_new (
  id          TEXT PRIMARY KEY,
  board_id    TEXT NOT NULL REFERENCES boards(id),
  type        TEXT NOT NULL CHECK (type IN ('note','checklist','image','link','section','folder','connector')),
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  z           INTEGER NOT NULL DEFAULT 0,
  color       TEXT,                          -- palette key, nullable
  data        TEXT NOT NULL,                 -- JSON, shape depends on type
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);

INSERT INTO items_new (id, board_id, type, x, y, w, h, z, color, data, created_at, updated_at, deleted_at)
SELECT id, board_id, type, x, y, w, h, z, color, data, created_at, updated_at, deleted_at FROM items;

DROP TABLE items;
ALTER TABLE items_new RENAME TO items;
CREATE INDEX items_board ON items(board_id, deleted_at);
