import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chunkRows } from "../src/hub/transfer.js";

const bytes = (text) => new TextEncoder().encode(text).length;

describe("chunkRows", () => {
  it("returns nothing for no rows", () => {
    assert.deepEqual(chunkRows([]), []);
  });

  it("keeps the rows, in order, across chunks", () => {
    const rows = Array.from({ length: 1_001 }, (_, i) => ({ id: i }));
    const chunks = chunkRows(rows);

    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks.flatMap((chunk) => JSON.parse(chunk)), rows);
  });

  it("starts a new chunk before the byte limit is passed", () => {
    // 400 cards of about 60 KB each: far more than one statement can carry.
    const rows = Array.from({ length: 400 }, (_, i) => ({ id: i, data: "é".repeat(30_000) }));
    const chunks = chunkRows(rows);

    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => bytes(chunk) <= 1_000_000));
    assert.deepEqual(chunks.flatMap((chunk) => JSON.parse(chunk)).map((row) => row.id), rows.map((row) => row.id));
  });

  it("gives a row larger than the limit a chunk of its own", () => {
    const chunks = chunkRows([{ id: 1 }, { id: 2, data: "x".repeat(500) }, { id: 3 }], 400, 100);

    assert.equal(chunks.length, 3);
  });
});
