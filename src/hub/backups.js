// Automatic backups (docs/hub-spec.md, section 5 "Backups"). Once a day (the
// cron trigger in wrangler.jsonc, handled by `scheduled` in src/index.js) the
// hub saves an export of every board and card to R2 under backups/, if
// anything changed since the last one. The newest KEEP_BACKUPS are kept.
// Images aren't copied: they stay in R2 under images/ and are never deleted.
// A backup can be downloaded, or restored as a copy in a new folder on Home.

import { HttpError, json } from "./http.js";
import { buildExport, importData } from "./transfer.js";

const PREFIX = "backups/";
export const KEEP_BACKUPS = 30;
const NAME_PATTERN = /^retne-hub-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.json$/;

// "retne-hub-2026-11-17-031700.json" for 03:17:00 UTC. Names sort by time.
export function backupName(date) {
  const iso = date.toISOString();
  return `retne-hub-${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}.json`;
}

export function isBackupName(name) {
  return typeof name === "string" && NAME_PATTERN.test(name);
}

// "Backup 2026-11-17 03:17 UTC": the folder a restored backup goes in.
export function restoredName(name) {
  const [, year, month, day, hour, minute] = NAME_PATTERN.exec(name);
  return `Backup ${year}-${month}-${day} ${hour}:${minute} UTC`;
}

// The keys to delete so that only the newest `keep` remain (keys sort by time).
export function keysToPrune(keys, keep = KEEP_BACKUPS) {
  return [...keys].sort().reverse().slice(keep);
}

// When anything was last changed: a card or board saved, renamed or deleted.
// Panning and zooming don't count.
async function latestChange(env) {
  const row = await env.DB.prepare(
    `SELECT MAX(changed) AS latest FROM (
       SELECT MAX(updated_at) AS changed FROM boards
       UNION ALL
       SELECT MAX(updated_at) AS changed FROM items
     )`
  ).first();

  return row?.latest ?? 0;
}

// Backups in R2, newest first.
async function listBackupObjects(env) {
  const listed = await env.FILES.list({ prefix: PREFIX, include: ["customMetadata"] });

  return listed.objects
    .filter((object) => isBackupName(object.key.slice(PREFIX.length)))
    .sort((a, b) => b.key.localeCompare(a.key));
}

function describe(object) {
  const meta = object.customMetadata ?? {};

  return {
    name: object.key.slice(PREFIX.length),
    createdAt: object.uploaded.getTime(),
    size: object.size,
    boards: Number(meta.boards) || 0,
    cards: Number(meta.cards) || 0
  };
}

// Saves a backup unless nothing changed since the newest one.
// Returns { created, backup } (backup: the new one, or the newest existing).
export async function runBackup(env, now = new Date()) {
  const [latest, objects] = await Promise.all([latestChange(env), listBackupObjects(env)]);

  if (objects.length && objects[0].customMetadata?.latestChange === String(latest)) {
    return { created: false, backup: describe(objects[0]) };
  }

  const data = await buildExport(env, now);
  const key = PREFIX + backupName(now);
  const object = await env.FILES.put(key, JSON.stringify(data), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      latestChange: String(latest),
      boards: String(data.boards.length),
      cards: String(data.items.length)
    }
  });

  const old = keysToPrune([key, ...objects.map((existing) => existing.key)]);

  if (old.length) {
    await env.FILES.delete(old);
  }

  return { created: true, backup: describe(object) };
}

// Cron trigger: logged privately (wrangler tail), never thrown.
export async function scheduledBackup(env) {
  try {
    const { created, backup } = await runBackup(env);
    console.log(created ? `hub backup saved: ${backup.name}` : "hub backup skipped: nothing changed");
  } catch (error) {
    console.error("hub backup failed:", error?.message || error);
  }
}

function backupKey(name) {
  if (!isBackupName(name)) {
    throw new HttpError(404, "Backup not found.");
  }

  return PREFIX + name;
}

// GET /backups
export async function listBackups({ env }) {
  const objects = await listBackupObjects(env);
  return json({ backups: objects.map(describe), keep: KEEP_BACKUPS });
}

// POST /backups: back up now.
export async function createBackup({ env }) {
  return json(await runBackup(env));
}

// GET /backups/:name: downloads the backup file.
export async function getBackup({ env, params }) {
  const name = params[0];
  const object = await env.FILES.get(backupKey(name));

  if (!object) {
    throw new HttpError(404, "Backup not found.");
  }

  return new Response(object.body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(object.size),
      "content-disposition": `attachment; filename="${name}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store"
    }
  });
}

// POST /backups/:name/restore: adds the backup as a new folder on Home.
// Nothing that exists now is changed.
export async function restoreBackup({ env, params }) {
  const name = params[0];
  const object = await env.FILES.get(backupKey(name));

  if (!object) {
    throw new HttpError(404, "Backup not found.");
  }

  let data;

  try {
    data = JSON.parse(await object.text());
  } catch {
    throw new HttpError(400, "This backup can't be read.");
  }

  return json(await importData(env, data, { name: restoredName(name) }), 201);
}
