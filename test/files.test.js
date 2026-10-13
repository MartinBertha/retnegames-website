// Checks for image type detection (docs/hub-spec.md, section 5 uploads).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sniffImage } from "../src/hub/files.js";

const bytes = (...parts) => new Uint8Array(parts.flatMap((part) => (
  typeof part === "string" ? [...part].map((char) => char.charCodeAt(0)) : part
)));

// Real 1x1 images.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);
const GIF_1X1 = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

describe("sniffImage", () => {
  it("reads PNG and GIF sizes", () => {
    assert.deepEqual(sniffImage(new Uint8Array(PNG_1X1)), { mime: "image/png", width: 1, height: 1 });
    assert.deepEqual(sniffImage(new Uint8Array(GIF_1X1)), { mime: "image/gif", width: 1, height: 1 });
  });

  it("reads JPEG size from the frame header, skipping other segments", () => {
    const jpeg = bytes(
      [0xff, 0xd8],
      [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00], // APP0, length 4
      [0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20], // SOF0: 600 high, 800 wide
      new Array(12).fill(0)
    );
    assert.deepEqual(sniffImage(jpeg), { mime: "image/jpeg", width: 800, height: 600 });
  });

  it("reads WebP sizes (VP8X, VP8 and VP8L)", () => {
    const vp8x = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8X", [10, 0, 0, 0, 0, 0, 0, 0], [0x1f, 0x03, 0x00], [0xdf, 0x01, 0x00], [0, 0]);
    assert.deepEqual(sniffImage(vp8x), { mime: "image/webp", width: 800, height: 480 });

    const vp8 = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8 ", [0, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], [0x40, 0x01, 0xf0, 0x00]);
    assert.deepEqual(sniffImage(vp8), { mime: "image/webp", width: 320, height: 240 });

    // 2x3 lossless: width-1 = 1, height-1 = 2 packed into 14-bit fields.
    const vp8l = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8L", [0, 0, 0, 0], [0x2f], [0x01, 0x80, 0x00, 0x00], [0, 0, 0, 0, 0]);
    assert.deepEqual(sniffImage(vp8l), { mime: "image/webp", width: 2, height: 3 });
  });

  it("rejects SVG, HTML, other formats and truncated files", () => {
    const rejected = [
      bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      bytes('<?xml version="1.0"?><svg/>'),
      bytes("<html><body>hi</body></html>"),
      bytes("BM", new Array(40).fill(0)),
      bytes("%PDF-1.7", new Array(40).fill(0)),
      bytes([0x89, 0x50, 0x4e, 0x47]),
      new Uint8Array(PNG_1X1.subarray(0, 20)),
      bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),
      new Uint8Array(0)
    ];

    for (const file of rejected) {
      assert.equal(sniffImage(file), null);
    }
  });

  it("rejects zero-sized images", () => {
    const png = new Uint8Array(PNG_1X1);
    png.fill(0, 16, 20);
    assert.equal(sniffImage(png), null);
  });
});
