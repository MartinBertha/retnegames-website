import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";

import { crc32, readZip, ZipWriter } from "../public/hub/zip.js";

const encoder = new TextEncoder();

// A one-file archive whose entry is deflated, as other zip tools write them.
function deflatedZip(name, text) {
  const nameBytes = encoder.encode(name);
  const raw = encoder.encode(text);
  const packed = deflateRawSync(raw);
  const local = new Uint8Array(30 + nameBytes.length);
  const central = new Uint8Array(46 + nameBytes.length);
  const end = new Uint8Array(22);
  const l = new DataView(local.buffer);
  const c = new DataView(central.buffer);
  const e = new DataView(end.buffer);

  l.setUint32(0, 0x04034b50, true);
  l.setUint16(8, 8, true);
  l.setUint32(14, crc32(raw), true);
  l.setUint32(18, packed.length, true);
  l.setUint32(22, raw.length, true);
  l.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);

  c.setUint32(0, 0x02014b50, true);
  c.setUint16(10, 8, true);
  c.setUint32(16, crc32(raw), true);
  c.setUint32(20, packed.length, true);
  c.setUint32(24, raw.length, true);
  c.setUint16(28, nameBytes.length, true);
  c.setUint32(42, 0, true);
  central.set(nameBytes, 46);

  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, 1, true);
  e.setUint16(10, 1, true);
  e.setUint32(12, central.length, true);
  e.setUint32(16, local.length + packed.length, true);

  return new Blob([local, packed, central, end]);
}

describe("zip", () => {
  it("computes the standard CRC-32", () => {
    assert.equal(crc32(encoder.encode("123456789")), 0xcbf43926);
    assert.equal(crc32(new Uint8Array(0)), 0);
  });

  it("reads back what it writes", async () => {
    const zip = new ZipWriter(new Date(2026, 10, 17, 4, 17, 30));
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 255]);

    zip.addBytes("export.json", encoder.encode('{"format":"retne-hub-export"}'));
    await zip.addBlob("images/ü-ä.png", new Blob([image]));

    const entries = await readZip(zip.toBlob());

    assert.deepEqual([...entries.keys()], ["export.json", "images/ü-ä.png"]);
    assert.equal(await (await entries.get("export.json").blob()).text(), '{"format":"retne-hub-export"}');
    assert.deepEqual(new Uint8Array(await (await entries.get("images/ü-ä.png").blob()).arrayBuffer()), image);
    assert.equal(entries.get("images/ü-ä.png").size, image.length);
  });

  it("reads deflated entries", async () => {
    const text = "hello ".repeat(500);
    const entries = await readZip(deflatedZip("folder/export.json", text));

    assert.equal(await (await entries.get("folder/export.json").blob()).text(), text);
  });

  it("rejects a file that isn't a zip", async () => {
    await assert.rejects(readZip(new Blob(["not a zip at all"])), /isn't a \.zip file/);
  });
});
