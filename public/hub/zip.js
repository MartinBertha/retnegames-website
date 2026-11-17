// A small ZIP writer and reader for "Export with images" (no libraries). The
// writer stores files as they are (images are compressed already); the reader
// takes stored and deflated entries, so a backup re-zipped by another tool
// still imports. No ZIP64: an archive must stay under 4 GB.

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const UTF8_NAMES = 0x0800;
const STORED = 0;
const DEFLATED = 8;
const MAX_ZIP32 = 0xffffffff;

const encoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n++) {
    let c = n;

    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }

    table[n] = c >>> 0;
  }

  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;

  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

// MS-DOS date and time, as ZIP stores them (local time, 2-second steps).
function dosTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

export class ZipWriter {
  constructor(date = new Date()) {
    this.stamp = dosTime(date);
    this.parts = [];
    this.entries = [];
    this.offset = 0;
  }

  // Adds a file from bytes, keeping `stored` (a Blob of the same bytes) in the
  // archive instead when given, so large files needn't stay in memory.
  addBytes(name, bytes, stored = bytes) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(bytes);
    const size = bytes.length;
    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);

    view.setUint32(0, LOCAL_HEADER, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, UTF8_NAMES, true);
    view.setUint16(8, STORED, true);
    view.setUint16(10, this.stamp.time, true);
    view.setUint16(12, this.stamp.date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    header.set(nameBytes, 30);

    if (this.offset + header.length + size > MAX_ZIP32) {
      throw new Error("The export is too large for a .zip file (4 GB).");
    }

    this.entries.push({ nameBytes, crc, size, offset: this.offset });
    this.parts.push(header, stored);
    this.offset += header.length + size;
  }

  async addBlob(name, blob) {
    this.addBytes(name, new Uint8Array(await blob.arrayBuffer()), blob);
  }

  toBlob() {
    const central = [];
    let centralSize = 0;

    for (const entry of this.entries) {
      const record = new Uint8Array(46 + entry.nameBytes.length);
      const view = new DataView(record.buffer);

      view.setUint32(0, CENTRAL_HEADER, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 20, true);
      view.setUint16(8, UTF8_NAMES, true);
      view.setUint16(10, STORED, true);
      view.setUint16(12, this.stamp.time, true);
      view.setUint16(14, this.stamp.date, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, entry.size, true);
      view.setUint32(24, entry.size, true);
      view.setUint16(28, entry.nameBytes.length, true);
      view.setUint32(42, entry.offset, true);
      record.set(entry.nameBytes, 46);
      central.push(record);
      centralSize += record.length;
    }

    if (this.entries.length > 0xffff || this.offset + centralSize > MAX_ZIP32) {
      throw new Error("The export is too large for a .zip file.");
    }

    const end = new Uint8Array(22);
    const view = new DataView(end.buffer);
    view.setUint32(0, END_OF_CENTRAL, true);
    view.setUint16(8, this.entries.length, true);
    view.setUint16(10, this.entries.length, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, this.offset, true);

    return new Blob([...this.parts, ...central, end], { type: "application/zip" });
  }
}

class ZipError extends Error {}

async function bytesOf(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

// Reads a ZIP file's list of entries. Returns a Map of name -> entry, where
// entry.blob() gives the file's contents.
export async function readZip(file) {
  const tailLength = Math.min(file.size, 22 + 0xffff);
  const tail = await bytesOf(file, file.size - tailLength, file.size);
  const tailView = new DataView(tail.buffer);
  let endAt = -1;

  for (let i = tail.length - 22; i >= 0; i--) {
    if (tailView.getUint32(i, true) === END_OF_CENTRAL) {
      endAt = i;
      break;
    }
  }

  if (endAt < 0) {
    throw new ZipError("This isn't a .zip file.");
  }

  const count = tailView.getUint16(endAt + 10, true);
  const centralSize = tailView.getUint32(endAt + 12, true);
  const centralOffset = tailView.getUint32(endAt + 16, true);

  if (centralOffset === MAX_ZIP32 || centralOffset + centralSize > file.size) {
    throw new ZipError("This .zip file can't be read.");
  }

  const central = await bytesOf(file, centralOffset, centralOffset + centralSize);
  const view = new DataView(central.buffer);
  const decoder = new TextDecoder();
  const entries = new Map();
  let at = 0;

  for (let index = 0; index < count; index++) {
    if (at + 46 > central.length || view.getUint32(at, true) !== CENTRAL_HEADER) {
      throw new ZipError("This .zip file can't be read.");
    }

    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = decoder.decode(central.subarray(at + 46, at + 46 + nameLength));

    at += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) {
      continue;
    }

    entries.set(name, {
      name,
      size,
      blob: () => entryBlob(file, { method, compressedSize, localOffset })
    });
  }

  return entries;
}

async function entryBlob(file, { method, compressedSize, localOffset }) {
  const header = await bytesOf(file, localOffset, localOffset + 30);
  const view = new DataView(header.buffer);

  if (header.length < 30 || view.getUint32(0, true) !== LOCAL_HEADER) {
    throw new ZipError("This .zip file can't be read.");
  }

  const start = localOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
  const data = file.slice(start, start + compressedSize);

  if (method === STORED) {
    return data;
  }

  if (method === DEFLATED && typeof DecompressionStream === "function") {
    return new Response(data.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
  }

  throw new ZipError("This .zip file uses compression that can't be read here.");
}
