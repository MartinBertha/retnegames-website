-- retne hub: initial schema (docs/hub-spec.md, section 4).
-- Ids are client-generated UUID v4; timestamps are Unix epoch milliseconds.

CREATE TABLE boards (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT REFERENCES boards(id),   -- NULL only for the root board
  name        TEXT NOT NULL,
  view_x      REAL NOT NULL DEFAULT 0,      -- last pan/zoom, restored on open
  view_y      REAL NOT NULL DEFAULT 0,
  view_zoom   REAL NOT NULL DEFAULT 1,
  rev         INTEGER NOT NULL DEFAULT 0,   -- incremented on every change to the board's items
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX boards_parent ON boards(parent_id, deleted_at);

-- At most one root board.
CREATE UNIQUE INDEX boards_single_root ON boards(parent_id IS NULL) WHERE parent_id IS NULL;

CREATE TABLE items (
  id          TEXT PRIMARY KEY,
  board_id    TEXT NOT NULL REFERENCES boards(id),
  type        TEXT NOT NULL CHECK (type IN ('note','checklist','image','link','section','folder')),
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  z           INTEGER NOT NULL DEFAULT 0,
  color       TEXT,                          -- palette key, nullable
  data        TEXT NOT NULL,                 -- JSON, shape depends on type
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX items_board ON items(board_id, deleted_at);

CREATE TABLE files (
  id          TEXT PRIMARY KEY,              -- also the R2 object key: images/<id>
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  width       INTEGER, height INTEGER,
  created_at  INTEGER NOT NULL
);
