// Image files from the picker, drag-drop or paste (docs/hub-spec.md, section 6).
// The server checks every upload again; these checks give a clear message early.

export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

const ALLOWED_TYPES = new Set(IMAGE_ACCEPT.split(","));
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_EDGE = 2400;
const QUALITY = 0.9;

export class ImageError extends Error {}

// A reason the file can't be added, or null.
export function imageFileProblem(file) {
  const name = file.name || "That file";

  if (file.type === "image/svg+xml" || /\.svgz?$/i.test(file.name || "")) {
    return `${name}: SVG images can't be added. Use PNG, JPEG, WebP or GIF.`;
  }

  if (!ALLOWED_TYPES.has(file.type)) {
    return `${name}: only PNG, JPEG, WebP and GIF images can be added.`;
  }

  // Large GIFs aren't re-encoded (that would drop the animation).
  if (file.type === "image/gif" && file.size > MAX_BYTES) {
    return `${name}: images must be 10 MB or smaller.`;
  }

  return null;
}

function canvasToBlob(canvas, type) {
  if (canvas.convertToBlob) {
    return canvas.convertToBlob({ type, quality: QUALITY });
  }

  return new Promise((resolve) => canvas.toBlob(resolve, type, QUALITY));
}

async function encode(bitmap, width, height, type) {
  const canvas = typeof OffscreenCanvas === "function"
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement("canvas"), { width, height });
  const context = canvas.getContext("2d");

  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  return canvasToBlob(canvas, type);
}

// Returns { blob, width, height } ready to upload: images over 2,400 px on
// the long edge (or over 10 MB) are downscaled and re-encoded in the browser.
export async function prepareImage(file) {
  const name = file.name || "That file";

  if (file.type === "image/gif") {
    const bitmap = await createImageBitmap(file).catch(() => null);
    return { blob: file, width: bitmap?.width ?? 0, height: bitmap?.height ?? 0 };
  }

  let bitmap;

  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new ImageError(`${name}: the image couldn't be read.`);
  }

  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));

  if (scale === 1 && file.size <= MAX_BYTES) {
    return { blob: file, width, height };
  }

  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  let blob = await encode(bitmap, targetWidth, targetHeight, file.type);

  // A big PNG photo can stay over the limit; WebP is much smaller.
  if (blob && blob.size > MAX_BYTES) {
    blob = await encode(bitmap, targetWidth, targetHeight, "image/webp");
  }

  if (!blob || !ALLOWED_TYPES.has(blob.type) || blob.size > MAX_BYTES) {
    throw new ImageError(`${name}: images must be 10 MB or smaller.`);
  }

  return { blob, width: targetWidth, height: targetHeight };
}
