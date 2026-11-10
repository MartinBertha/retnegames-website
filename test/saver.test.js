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
