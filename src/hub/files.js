// Image uploads and serving (docs/hub-spec.md, section 5). The type comes
// from the file's own bytes, never from what the client declares; only PNG,
// JPEG, WebP and GIF are accepted (no SVG). Files live in R2 under images/<id>.

import { HttpError, json, readBytes } from "./http.js";
import { isUuid } from "./validate.js";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

const ascii = (bytes, start, text) => [...text].every((char, i) => bytes[start + i] === char.charCodeAt(0));
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b, i) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);

function jpegSize(bytes) {
  let i = 2;

  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      return null;
    }

    const marker = bytes[i + 1];

    if (marker === 0xff) {
      i++;
      continue;
    }

    if (JPEG_FRAME_MARKERS.has(marker)) {
      return { height: u16be(bytes, i + 5), width: u16be(bytes, i + 7) };
    }

    // Markers without a length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
    } else {
      i += 2 + u16be(bytes, i + 2);
    }
  }

  return null;
}

function webpSize(bytes) {
  if (ascii(bytes, 12, "VP8 ") && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }

  if (ascii(bytes, 12, "VP8L") && bytes[20] === 0x2f) {
    const [b1, b2, b3, b4] = bytes.subarray(21, 25);
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))
    };
  }

  if (ascii(bytes, 12, "VP8X")) {
    return { width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) };
  }

  return null;
}

// Identifies an allowed image from its magic bytes and reads its pixel size.
export function sniffImage(bytes) {
  let mime = null;
  let size = null;

  if (bytes.length >= 24 && ascii(bytes, 0, "\x89PNG\r\n\x1a\n") && ascii(bytes, 12, "IHDR")) {
    mime = "image/png";
    size = { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mime = "image/jpeg";
    size = jpegSize(bytes);
  } else if (bytes.length >= 10 && (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a"))) {
    mime = "image/gif";
    size = { width: u16le(bytes, 6), height: u16le(bytes, 8) };
  } else if (bytes.length >= 30 && ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
    mime = "image/webp";
    size = webpSize(bytes);
  }

  if (!mime || !size || !size.width || !size.height) {
    return null;
  }

  return { mime, ...size };
}

// POST /files: raw image body. Same-origin is checked by the API router.
export async function uploadFile({ request, env }) {
  const declared = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();

  // A non-form content type also forces a CORS preflight for any cross-site request.
  if (!declared.startsWith("image/")) {
    throw new HttpError(415, "Upload an image file.");
  }

  const bytes = await readBytes(request, MAX_UPLOAD_BYTES, "Images must be 10 MB or smaller.");
  const image = sniffImage(bytes);

  if (!image) {
    throw new HttpError(415, "Only PNG, JPEG, WebP and GIF images can be added.");
  }

  const id = crypto.randomUUID();

  await env.FILES.put(`images/${id}`, bytes, { httpMetadata: { contentType: image.mime } });
  await env.DB.prepare(
    `INSERT INTO files (id, mime, size, width, height, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(id, image.mime, bytes.byteLength, image.width, image.height, Date.now()).run();

  return json({ id, width: image.width, height: image.height }, 201);
}

// GET /files/:id. Ids are never reused, so the browser may cache forever.
export async function getFile({ env, params }) {
  const id = params[0];
  const object = isUuid(id) ? await env.FILES.get(`images/${id}`) : null;
  const mime = object?.httpMetadata?.contentType;

  if (!object || !IMAGE_TYPES.has(mime)) {
    throw new HttpError(404, "Image not found.");
  }

  return new Response(object.body, {
    headers: {
      "content-type": mime,
      "content-length": String(object.size),
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=31536000, immutable",
      etag: object.httpEtag
    }
  });
}
