// Folder links (docs/hub-spec.md, section 4). A folder card opens a board,
// and several folder cards, in any boards, may open the same board. A board
// is deleted only when its last folder card goes, together with the boards
// that can then only be reached from deleted boards; undo restores the same
// set. A folder may never end up inside itself.
//
// graph: { boards: Map(id -> { id, parentId, name, deletedAt }),
//          links: [{ id, boardId, child }] }  (live folder cards only)

export async function loadGraph(env) {
  const [boards, links] = await env.DB.batch([
    env.DB.prepare("SELECT id, parent_id, name, deleted_at FROM boards"),
    env.DB.prepare(
      `SELECT id, board_id, json_extract(data, '$.childBoardId') AS child
       FROM items WHERE type = 'folder' AND deleted_at IS NULL`
    )
  ]);

  return {
    boards: new Map(boards.results.map((row) => [
      row.id,
      { id: row.id, parentId: row.parent_id, name: row.name, deletedAt: row.deleted_at }
    ])),
    links: links.results.map((row) => ({ id: row.id, boardId: row.board_id, child: row.child }))
  };
}

const isLive = (graph, id) => graph.boards.get(id)?.deletedAt === null;

function incomingLinks(links) {
  const incoming = new Map();

  for (const link of links) {
    incoming.set(link.child, [...(incoming.get(link.child) ?? []), link]);
  }

  return incoming;
}

// Boards reachable from `start` by opening folder cards on live boards.
export function reachable(graph, start, links) {
  const seen = new Set([start]);
  const queue = [start];

  while (queue.length) {
    const board = queue.shift();

    for (const link of links) {
      if (link.boardId === board && !seen.has(link.child) && isLive(graph, link.child)) {
        seen.add(link.child);
        queue.push(link.child);
      }
    }
  }

  return seen;
}

// True when a live folder card on a live board opens `boardId`.
export function hasLiveLink(graph, boardId, links) {
  return links.some((link) => link.child === boardId && isLive(graph, link.boardId));
}

// Boards to delete once `start` has lost its last folder card: start, plus
// every board that is then only reachable from boards being deleted (or, if
// no card opens it at all, whose home is being deleted). Never the root.
export function boardsToDelete(graph, start, links, rootId) {
  const doomed = new Set();

  if (!isLive(graph, start) || start === rootId) {
    return doomed;
  }

  const incoming = incomingLinks(links);
  doomed.add(start);

  for (let changed = true; changed;) {
    changed = false;

    for (const board of graph.boards.values()) {
      if (doomed.has(board.id) || board.deletedAt !== null || board.id === rootId) {
        continue;
      }

      const cards = (incoming.get(board.id) ?? []).filter((link) => isLive(graph, link.boardId));
      const keptFromOutside = cards.some((link) => !doomed.has(link.boardId));
      const ownedByDoomed = cards.length
        ? cards.some((link) => doomed.has(link.boardId))
        : doomed.has(board.parentId);

      if (!keptFromOutside && ownedByDoomed) {
        doomed.add(board.id);
        changed = true;
      }
    }
  }

  return doomed;
}

// The boards deleted together with `start` (same deleted_at) that it leads to.
export function boardsToRestore(graph, start, links) {
  const first = graph.boards.get(start);

  if (!first || first.deletedAt === null) {
    return new Set();
  }

  const stamp = first.deletedAt;
  const found = new Set([start]);
  const queue = [start];

  while (queue.length) {
    const board = queue.shift();
    const next = [
      ...links.filter((link) => link.boardId === board).map((link) => link.child),
      ...[...graph.boards.values()].filter((child) => child.parentId === board).map((child) => child.id)
    ];

    for (const id of next) {
      if (!found.has(id) && graph.boards.get(id)?.deletedAt === stamp) {
        found.add(id);
        queue.push(id);
      }
    }
  }

  return found;
}
