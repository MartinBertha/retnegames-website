import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Saver } from "../public/hub/saver.js";

const BOARD = "board-1";
const upsert = (id) => ({ op: "upsert", item: { id } });

function rejection(status, message = "Rejected.") {
  return Object.assign(new Error(message), { status });
}

// A saver whose server rejects any request containing a card in `bad`.
function setup({ bad = [], status = 400 } = {}) {
  const requests = [];
  const rejected = [];
  const states = [];

  const saver = new Saver({
    save: async (boardId, ops) => {
      const ids = ops.map((op) => (op.op === "delete" ? op.id : op.item.id));
      requests.push(ids);

      if (ids.some((id) => bad.includes(id))) {
        throw rejection(status);
      }

      return { rev: requests.length };
    },
    onStatus: (state) => states.push(state),
    onRejected: (error) => rejected.push(error.status)
  });

  return { saver, requests, rejected, states };
}

describe("Saver", () => {
  it("sends queued changes in one request", async () => {
    const { saver, requests, rejected, states } = setup();

    saver.queue(BOARD, [upsert("a"), upsert("b")]);
    assert.equal(await saver.flush(), true);

    assert.deepEqual(requests, [["a", "b"]]);
    assert.deepEqual(rejected, []);
    assert.equal(saver.hasUnsaved(), false);
    assert.equal(states.at(-1), "saved");
  });

  it("saves the other cards when one card in a batch is rejected", async () => {
    const { saver, requests, rejected, states } = setup({ bad: ["b"] });

    saver.queue(BOARD, [upsert("a"), upsert("b"), upsert("c")]);
    assert.equal(await saver.flush(), true);

    assert.deepEqual(requests, [["a", "b", "c"], ["a"], ["b"], ["c"]]);
    assert.deepEqual(rejected, [400]);
    assert.equal(saver.hasUnsaved(), false);
    assert.equal(states.at(-1), "error");
  });

  it("doesn't retry card by card when the board is gone", async () => {
    const { saver, requests, rejected } = setup({ bad: ["a"], status: 404 });

    saver.queue(BOARD, [upsert("a"), upsert("b")]);
    assert.equal(await saver.flush(), true);

    assert.deepEqual(requests, [["a", "b"]]);
    assert.deepEqual(rejected, [404]);
    assert.equal(saver.hasUnsaved(), false);
  });

  it("keeps unsent changes when the connection drops part-way", async () => {
    const requests = [];
    const saver = new Saver({
      save: async (boardId, ops) => {
        const ids = ops.map((op) => op.item.id);
        requests.push(ids);

        if (ids.length > 1) {
          throw rejection(400);
        }

        if (ids[0] === "b") {
          throw rejection(0, "Can't reach the server.");
        }

        return { rev: 1 };
      }
    });

    saver.queue(BOARD, [upsert("a"), upsert("b"), upsert("c")]);
    assert.equal(await saver.flush(), false);
    clearTimeout(saver.retryTimer);

    assert.deepEqual(requests, [["a", "b", "c"], ["a"], ["b"]]);
    assert.deepEqual(saver.localOps(BOARD).map((op) => op.item.id), ["b", "c"]);
  });
});

const card = (id, text, extra = {}) => ({
  id,
  type: "note",
  x: 0,
  y: 0,
  w: 240,
  h: 120,
  z: 1,
  color: null,
  data: { title: "", text, size: "m" },
  ...extra
});

// A server that stores cards with an updatedAt and reports conflicts the way
// /changes does: an upsert whose base isn't the stored updatedAt is skipped.
function conflictServer(stored = new Map()) {
  let clock = 1000;
  const requests = [];

  return {
    stored,
    requests,
    save: async (boardId, ops) => {
      requests.push(structuredClone(ops));
      const now = ++clock;
      const conflicts = [];

      for (const op of ops) {
        const row = stored.get(op.op === "delete" ? op.id : op.item.id);

        if (op.op === "upsert") {
          if (row && op.base != null && row.updatedAt !== op.base) {
            conflicts.push({ item: structuredClone(row), deleted: Boolean(row.deleted) });
          } else {
            stored.set(op.item.id, { ...structuredClone(op.item), updatedAt: now });
          }
        } else if (row) {
          stored.set(op.id, { ...row, deleted: true, updatedAt: now });
        }
      }

      return { rev: now, updatedAt: now, conflicts };
    },
    // Another device saves a card.
    edit: (item) => stored.set(item.id, { ...structuredClone(item), updatedAt: ++clock })
  };
}

describe("Saver conflicts", () => {
  it("sends the stored version each change was made from", async () => {
    const server = conflictServer(new Map([["a", { ...card("a", "one"), updatedAt: 5 }]]));
    const saver = new Saver({ save: server.save });

    saver.remember([{ ...card("a", "one"), updatedAt: 5 }]);
    saver.queue(BOARD, [{ op: "upsert", item: card("a", "two") }]);
    await saver.flush();

    assert.equal(server.requests[0][0].base, 5);

    // The next change is made from what was just saved.
    saver.queue(BOARD, [{ op: "upsert", item: card("a", "three") }]);
    await saver.flush();

    assert.equal(server.requests[1][0].base, server.stored.get("a").updatedAt - 1);
    assert.equal(server.stored.get("a").data.text, "three");
  });

  it("hands a card changed elsewhere to onConflicts with all three versions", async () => {
    const server = conflictServer(new Map([["a", { ...card("a", "one"), updatedAt: 5 }]]));
    const seen = [];
    const saver = new Saver({ save: server.save, onConflicts: (boardId, conflicts) => seen.push(...conflicts) });

    saver.remember([{ ...card("a", "one"), updatedAt: 5 }]);
    server.edit(card("a", "theirs"));
    saver.queue(BOARD, [{ op: "upsert", item: card("a", "one", { x: 48 }) }]);
    await saver.flush();

    assert.equal(seen.length, 1);
    assert.equal(seen[0].base.data.text, "one");
    assert.equal(seen[0].local.x, 48);
    assert.equal(seen[0].server.data.text, "theirs");
    assert.equal(seen[0].deleted, false);
    // Not saved over the other device's version.
    assert.equal(server.stored.get("a").data.text, "theirs");
  });

  it("saves the merged card with the new base", async () => {
    const server = conflictServer(new Map([["a", { ...card("a", "one"), updatedAt: 5 }]]));
    const saver = new Saver({
      save: server.save,
      onConflicts: (boardId, conflicts) => {
        const { server: theirs, local } = conflicts[0];
        saver.queue(boardId, [{ op: "upsert", item: { ...theirs, x: local.x } }]);
      }
    });

    saver.remember([{ ...card("a", "one"), updatedAt: 5 }]);
    server.edit(card("a", "theirs"));
    saver.queue(BOARD, [{ op: "upsert", item: card("a", "one", { x: 48 }) }]);
    assert.equal(await saver.flush(), true);

    const stored = server.stored.get("a");
    assert.equal(stored.data.text, "theirs");
    assert.equal(stored.x, 48);
    assert.equal(saver.hasUnsaved(), false);
  });

  it("doesn't take a card saved before the connection dropped for a conflict", async () => {
    const server = conflictServer(new Map([["a", { ...card("a", "one"), updatedAt: 5 }]]));
    const seen = [];
    let dropNext = true;
    const saver = new Saver({
      save: async (boardId, ops, options) => {
        const result = await server.save(boardId, ops, options);

        // Saved, but the answer never arrives.
        if (dropNext) {
          dropNext = false;
          throw rejection(0, "Can't reach the server.");
        }

        return result;
      },
      onConflicts: (boardId, conflicts) => seen.push(...conflicts)
    });

    saver.remember([{ ...card("a", "one"), updatedAt: 5 }]);
    saver.queue(BOARD, [{ op: "upsert", item: card("a", "two") }]);
    assert.equal(await saver.flush(), false);
    clearTimeout(saver.retryTimer);
    assert.equal(await saver.flush(), true);

    assert.deepEqual(seen, []);
    assert.equal(server.stored.get("a").data.text, "two");
    assert.equal(saver.hasUnsaved(), false);
  });

  it("lets a later undo of a delete restore the card", async () => {
    const server = conflictServer(new Map([["a", { ...card("a", "one"), updatedAt: 5 }]]));
    const seen = [];
    const saver = new Saver({ save: server.save, onConflicts: (boardId, conflicts) => seen.push(...conflicts) });

    saver.remember([{ ...card("a", "one"), updatedAt: 5 }]);
    saver.queue(BOARD, [{ op: "delete", id: "a" }]);
    await saver.flush();
    saver.queue(BOARD, [{ op: "upsert", item: card("a", "one") }]);
    await saver.flush();

    assert.deepEqual(seen, []);
    assert.equal(server.stored.get("a").deleted, undefined);
  });

  it("keeps the base of a card with unsaved changes when the board is fetched again", () => {
    const saver = new Saver({ save: async () => ({ rev: 1 }) });

    saver.remember([{ ...card("a", "one"), updatedAt: 5 }]);
    saver.queue(BOARD, [{ op: "upsert", item: card("a", "two") }]);
    saver.remember([{ ...card("a", "theirs"), updatedAt: 9 }]);
    clearTimeout(saver.debounceTimer);

    assert.equal(saver.bases.get("a").updatedAt, 5);
  });
});
