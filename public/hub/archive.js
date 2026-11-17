// Export with images (a .zip) and importing one (docs/hub-spec.md, section 6).
// The archive holds export.json (the same file as "Export without images")
// and every image as images/<fileId>.<ext>. Importing it uploads only the
// images this hub doesn't have, so a backup restores into an empty hub too.

import { api } from "./api.js";
import { readZip, ZipWriter } from "./zip.js";

const EXPORT_ENTRY = "export.json";
const IMAGE_ENTRY = /(?:^|\/)images\/([0-9a-f-]{36})\.[a-z0-9]+$/i;
const LOOKUP_BATCH = 1_000;
const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

const README = [
  "retne.games HUB export with images.",
  "",
  "export.json holds every board and card; images/ holds the images, named by their id.",
  "To restore it, open the hub, choose ⋯ > Import an export…, and pick this .zip file.",
  "Importing adds everything as a new folder on Home; nothing that exists is changed.",
  ""
].join("\n");

// Builds the .zip. onProgress(done, total) while images are added.
// Returns { blob, name, images, missing }.
export async function exportWithImages({ onProgress } = {}) {
  const response = await api.exportAll();
  const text = await response.text();
  const data = JSON.parse(text);
  const files = Array.isArray(data.files) ? data.files : [];
  const zip = new ZipWriter(new Date(data.exportedAt));
  const encoder = new TextEncoder();
  let missing = 0;

  zip.addBytes(EXPORT_ENTRY, encoder.encode(text));
  zip.addBytes("README.txt", encoder.encode(README));

  for (const [index, file] of files.entries()) {
    onProgress?.(index + 1, files.length);

    let blob;

    try {
      blob = await api.downloadFile(file.id);
    } catch (error) {
      // Gone from storage: the card stays in export.json, without its image.
      if (error?.status === 404) {
        missing++;
        continue;
      }

      throw error;
    }

    await zip.addBlob(`images/${file.id}.${EXTENSIONS[file.mime] ?? "bin"}`, blob);
  }

  return {
    blob: zip.toBlob(),
    name: `retne-hub-${String(data.exportedAt).slice(0, 10)}.zip`,
    images: files.length - missing,
    missing
  };
}

export const isZip = (file) => /\.zip$/i.test(file.name)
  || file.type === "application/zip"
  || file.type === "application/x-zip-compressed";

// Reads an export .zip and uploads the images this hub is missing, pointing
// the cards at the uploaded copies. Returns { data, uploaded } where data is
// ready for POST /import. onProgress(done, total) while uploading.
export async function unpackZipExport(file, { onProgress } = {}) {
  const entries = await readZip(file);
  const exportEntry = [...entries.values()]
    .filter((entry) => entry.name === EXPORT_ENTRY || entry.name.endsWith(`/${EXPORT_ENTRY}`))
    .sort((a, b) => a.name.length - b.name.length)[0];

  if (!exportEntry) {
    throw new Error(`${file.name} has no export.json, so it isn't a retne.games HUB export.`);
  }

  let data;

  try {
    data = JSON.parse(await (await exportEntry.blob()).text());
  } catch {
    throw new Error(`${file.name} isn't a retne.games HUB export.`);
  }

  if (data?.format !== "retne-hub-export" || !Array.isArray(data.items)) {
    throw new Error(`${file.name} isn't a retne.games HUB export.`);
  }

  const images = new Map();

  for (const entry of entries.values()) {
    const match = IMAGE_ENTRY.exec(entry.name);

    if (match) {
      images.set(match[1].toLowerCase(), entry);
    }
  }

  const fileIds = [...new Set(
    data.items
      .filter((item) => item?.type === "image" && typeof item.data?.fileId === "string")
      .map((item) => item.data.fileId)
  )];
  const missing = [];

  for (let start = 0; start < fileIds.length; start += LOOKUP_BATCH) {
    const { missing: batch } = await api.missingFiles(fileIds.slice(start, start + LOOKUP_BATCH));
    missing.push(...batch.filter((id) => images.has(id)));
  }

  const mimes = new Map((Array.isArray(data.files) ? data.files : []).map((info) => [info?.id, info?.mime]));
  const newIds = new Map();

  for (const [index, id] of missing.entries()) {
    onProgress?.(index + 1, missing.length);

    const entry = images.get(id);
    const extension = entry.name.split(".").pop().toLowerCase();
    const type = mimes.get(id) ?? TYPES[extension] ?? "application/octet-stream";
    const blob = new Blob([await entry.blob()], { type });
    const uploaded = await api.uploadFile(blob);
    newIds.set(id, uploaded.id);
  }

  for (const item of data.items) {
    if (item?.type === "image" && newIds.has(item.data?.fileId)) {
      item.data.fileId = newIds.get(item.data.fileId);
    }
  }

  if (Array.isArray(data.files)) {
    data.files = data.files.map((info) => (newIds.has(info?.id) ? { ...info, id: newIds.get(info.id) } : info));
  }

  return { data, uploaded: newIds.size };
}
