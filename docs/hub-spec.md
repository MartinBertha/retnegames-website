# retne hub: specification (v1)

A private, Milanote-style canvas tool for retne.games: infinite canvas boards with draggable cards (notes, checklists, images, links, sections) and folder cards that open nested boards. Used from desktop and phone. Data persists on the server.

This document is the source of truth for the build. Read it fully, plus `CLAUDE.md`, `README.md`, `wrangler.jsonc`, `src/index.js` and `public/` before writing code. Where this spec and `CLAUDE.md` conflict, `CLAUDE.md` wins.

---

## 1. Environment and fixed facts

The site is a Cloudflare Worker (`src/index.js`) serving static files from `public/` (see `wrangler.jsonc`). It is hosted at `https://retne.games`. The hub lives at **`https://retne.games/hub/`**.

Already created and configured by the owner (do not recreate):

| Item | Value |
|---|---|
| D1 database | name `retne-hub`, id `63201bfd-dc68-4989-a3bc-64695874662f` |
| R2 bucket | `retne-hub-files` (private, no public URL) |
| Access team domain | `sweet-brook-c60e.cloudflareaccess.com` |
| Access application | `retne-hub`, self-hosted, destinations `retne.games/hub/*` and `retne.games/hub` |
| Access AUD tag (production) | `f11069c640f2bbc86a83824c2de26e1205b137accd60c0f606ef4d3c5cda420f` (verify against the JWT during the first test) |
| Login method | GitHub (OAuth app), with the owner's GitHub two-factor authentication |
| Allowed identity | `admin@retne.games` (the email Access receives from GitHub) |

Staging (`--preview-alias staging`) sits behind a different Access application (Previews only), whose AUD tag differs. See section 9 and the open items in section 12.

Binding names to add to `wrangler.jsonc` (add by hand; **do not** let `wrangler` auto-edit the file, it would strip the comments that protect `workers_dev: false` and `preview_urls: true`):

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "retne-hub", "database_id": "63201bfd-dc68-4989-a3bc-64695874662f", "migrations_dir": "migrations" }
],
"r2_buckets": [
  { "binding": "FILES", "bucket_name": "retne-hub-files" }
],
"vars": {
  "ACCESS_TEAM_DOMAIN": "sweet-brook-c60e.cloudflareaccess.com",
  "ACCESS_AUDIENCES": "<production AUD>,<previews AUD if known>",
  "HUB_ALLOWED_EMAILS": "admin@retne.games"
}
```

None of these values are secrets. There are no new secrets in v1.

---

## 2. Scope

### In v1
- Boards: infinite canvas, pan and zoom (mouse and touch).
- Card types: **text note, checklist, image, link, section, folder**.
- Folder card: double-click opens a new blank board nested under the current one. Breadcrumb navigation back up.
- Drag, resize, multi-select, duplicate, delete, colour, bring to front or send to back, undo and redo.
- Drag-drop and paste for images, URLs and text.
- Autosave to the server, syncing across devices (desktop and phone).
- JSON export and import of the board structure.
- Dark and light theme.

### Explicitly out of v1
Connector arrows, global search, multi-user or sharing, real-time collaboration, offline mode, rich-text editing, trash or version-history UI, comments, due dates on checklist items, native mobile app, any third-party scripts or CDNs.

---

## 3. Architecture

- **Frontend:** plain HTML, CSS and JavaScript (ES modules), no framework, no build step, no bundler, no CDN. Files under `public/hub/`.
- **Backend:** the existing Worker. Add the hub API under `/hub/api/*`. Split hub code into modules (for example `src/hub/auth.js`, `src/hub/api.js`, `src/hub/files.js`) and keep `src/index.js` as the router. **Do not alter** the existing `/api/contact` behaviour or its protections (Origin check, Turnstile, honeypot, limits, rate limiting).
- **Data:** D1 for structured data, R2 for images.
- **Routing in `src/index.js`:** `/api/contact` is unchanged; `/hub/api/*` goes to the hub API; other `/hub` and `/hub/*` requests are served from assets with the hub's own security headers (section 8); everything else as today.

### Authentication (defence in depth)
Cloudflare Access gates `/hub` and `/hub/*` at the edge. The Worker **must additionally verify** the Access token on **every** `/hub` and `/hub/*` request, static or API, and return 403 on failure:

1. Read the `Cf-Access-Jwt-Assertion` header (or the `CF_Authorization` cookie as a fallback).
2. Fetch and cache the signing keys from `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (cache for about an hour; refetch on an unknown `kid`).
3. Verify the RS256 signature, `exp`, `nbf`, `iss` equal to `https://<ACCESS_TEAM_DOMAIN>`, and that `aud` contains one of `ACCESS_AUDIENCES`.
4. Verify the `email` claim is in `HUB_ALLOWED_EMAILS` (case-insensitive).
5. Use the Web Crypto API; no external libraries.

Local development: when `DEV_AUTH_BYPASS=true` is set in the git-ignored `.dev.vars` **and** the request host is `localhost` or `127.0.0.1`, skip verification. This variable must never appear in `wrangler.jsonc`.

CSRF: every state-changing request (POST, PATCH, PUT, DELETE) must carry an `Origin` header matching the request's own origin (`https://retne.games`, plus `http://localhost:8787` for local dev), and `Content-Type: application/json` (except file upload, see section 5). Reject otherwise.

---

## 4. Data model

D1 migrations live in `migrations/` (`0001_init.sql`, and so on). Use ids generated client-side as UUID v4 (`crypto.randomUUID()`); the server validates the format. Timestamps are integer milliseconds since the Unix epoch.

```sql
CREATE TABLE boards (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT REFERENCES boards(id),   -- NULL only for the root board
  name        TEXT NOT NULL,
  view_x      REAL NOT NULL DEFAULT 0,      -- last pan/zoom, restored on open
  view_y      REAL NOT NULL DEFAULT 0,
  view_zoom   REAL NOT NULL DEFAULT 1,
  rev         INTEGER NOT NULL DEFAULT 0,   -- incremented on every change to the board's items
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);

CREATE TABLE items (
  id          TEXT PRIMARY KEY,
  board_id    TEXT NOT NULL REFERENCES boards(id),
  type        TEXT NOT NULL CHECK (type IN ('note','checklist','image','link','section','folder')),
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  z           INTEGER NOT NULL DEFAULT 0,
  color       TEXT,                          -- palette key, nullable
  data        TEXT NOT NULL,                 -- JSON, shape depends on type
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX items_board ON items(board_id, deleted_at);

CREATE TABLE files (
  id          TEXT PRIMARY KEY,              -- also the R2 object key: images/<id>
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  width       INTEGER, height INTEGER,
  created_at  INTEGER NOT NULL
);
```

On first run (no boards exist), the API creates a root board named **Home**.

### Item `data` shapes

| Type | `data` |
|---|---|
| `note` | `{ "title": string, "text": string, "size": "s" \| "m" \| "l" }` optional one-line title (shown larger and bold) above plain, multi-line text; `size` is the text size. URLs are auto-linked at render time. Notes saved without `title` have none. |
| `checklist` | `{ "title": string, "entries": [ { "id": uuid, "text": string, "done": boolean } ] }` |
| `image` | `{ "fileId": uuid, "caption": string }` |
| `link` | `{ "url": string, "title": string }` (`http` or `https` only) |
| `section` | `{ "title": string }` a labelled coloured area drawn behind other cards |
| `folder` | `{ "name": string, "childBoardId": uuid }` |

### Checklist ordering rule (important)
The `entries` array is stored in display order and the following invariant always holds: **all unticked entries come first, all ticked entries come after.**
- Ticking an entry moves it to the **very bottom** of the list.
- Unticking an entry moves it to the **top of the unticked group** (first position).
- A new entry is added at the **bottom of the unticked group**.
- Entries can be reordered by drag within the unticked group (ticked entries are not draggable).
- Ticked entries render in grey (muted text and checkbox) at the bottom of the list; no strikethrough is required.
- The server enforces the invariant when saving (normalise if violated) so a buggy client cannot break it.

### Folder rules
- Creating a folder card **atomically** creates a child board (`parent_id` = current board) and stores its id in the item.
- Renaming the folder card renames the child board, and the reverse.
- Deleting a folder card soft-deletes the child board and all its descendants. Undo (client-side) restores both.
- Nesting depth is unlimited in principle; the UI breadcrumb truncates the middle on narrow screens.

### Validation limits
Note text 20,000 characters; checklist 200 entries, 500 characters each; names and titles 100 characters; URL 2,048 characters; item `data` 64 KB; 2,000 items per board; coordinates within ±1,000,000; width and height 40 to 10,000. Reject anything outside with 400.

---

## 5. API

All under `/hub/api`, JSON, `Cache-Control: no-store`, authenticated as in section 3. All SQL uses prepared statements with bound parameters; never string-concatenate SQL.

| Method and path | Purpose |
|---|---|
| `GET /boards` | All non-deleted boards as a flat list (`id`, `parentId`, `name`, `updatedAt`) |
| `GET /boards/:id` | Board metadata, `rev`, its non-deleted items, and the ancestor path for the breadcrumb |
| `GET /boards/:id/rev` | Just `{ rev }` (cheap check for changes from another device) |
| `PATCH /boards/:id` | Update `name` and/or view (`viewX`, `viewY`, `viewZoom`) |
| `POST /boards/:id/changes` | Batched item changes: `{ ops: [ { op: "upsert", item: {...} }, { op: "delete", id } ] }` |
| `POST /boards` | Create a board `{ id, parentId, name }` (the folder card flow normally goes through `/changes`) |
| `DELETE /boards/:id` | Soft-delete a board and descendants |
| `POST /files` | Upload an image (raw body, `Content-Type` of the image; header `X-Filename` optional) → `{ id, width, height }` |
| `GET /files/:id` | Stream the image from R2 |
| `GET /export` | Full JSON export (boards and items; images referenced by `fileId`, not embedded) |
| `POST /import` | Import an export into new boards under the root (never overwrites existing data) |

Notes:
- `/changes` is applied in one D1 batch (transaction), up to 100 ops and 256 KB per request. It bumps the board's `rev`. A folder `upsert` with a new `childBoardId` creates the child board in the same batch.
- **Conflicts:** per-item last write wins; the server stamps `updated_at`. Clients refetch the board when the tab regains focus, and when `/rev` shows a newer `rev`.
- **Uploads:** accept only PNG, JPEG, WebP and GIF, max 10 MB. Detect the type from the file's magic bytes server-side; ignore the declared type if it disagrees. **Reject SVG** (script risk). Store with the validated MIME in R2 under `images/<uuid>`.
- **Serving files:** `Content-Type` from the stored validated MIME, `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=31536000, immutable` (ids are unique and never reused).
- `DELETE` and delete ops are soft deletes (`deleted_at`). No purge job or trash UI in v1.

---

## 6. Frontend behaviour

### Layout
- **Top bar:** breadcrumb (Home › Game › Art), save status ("Saved", "Saving…", "Offline, retrying"), theme toggle, export and import (menu).
- **Add-card toolbar** (bottom on mobile, left on desktop): Note, Checklist, Image (file picker), Link, Section, Folder. Cards are added by **dragging** a button onto the canvas (an outline of the card follows the pointer and the card lands where it is dropped; dropping Image opens the file picker for that spot). A plain click only shows a hint; Enter or Space on a focused button adds the card in the middle of the view.
- **Canvas:** fills the rest of the screen. A subtle dot grid that scales with zoom.
- **Navigation state** in the URL hash: `#/b/<boardId>`, so refresh and browser back or forward work. No hash means the root board.

### Canvas
- A single "world" element transformed with `translate` and `scale`; cards are absolutely positioned DOM elements inside it.
- **Pan:** drag on empty canvas (or hold Space and drag, or middle mouse button). **Zoom:** mouse wheel or trackpad pinch, centred on the cursor, 10% to 400%.
- **Touch:** one finger on empty canvas pans; two fingers pinch-zoom and pan; tap selects; drag a card by its body; a card's edit mode is entered by double-tap.
- **Fit all** button (and key `F`) frames all cards on the board. The last pan and zoom per board is saved and restored on open.

### Cards
- **Select:** click or tap; Shift-click adds to the selection; drag a marquee on empty canvas to select several.
- **Move:** drag. **Resize:** handle on the bottom-right corner. Moving a **section** also moves the cards whose centre is inside it at the moment the drag starts.
- **Colour:** each card has a colour from a palette of about 8 muted tones (card background, adapting to dark and light themes).
- **Context menu** (right-click, or long-press on touch): Colour, Duplicate, Bring to front, Send to back, Delete.
- **Z-order** via the `z` field; newly created or clicked cards come to the front.
- **Double-click** a note, checklist title, link or section title to edit in place. **Double-click a folder** opens its board. **Double-click empty canvas** creates a new note at that point.

### Per-card details
- **Note:** a text area while editing; rendered as plain text with auto-linked URLs. Text size S, M or L from the context menu.
- **Checklist:** title plus entries with checkboxes; press Enter in an entry to add the next one; follows the ordering rule in section 4, with a short animation (disabled under `prefers-reduced-motion`).
- **Image:** shows the image scaled to the card with an optional caption; resize keeps the aspect ratio by default. The client downscales images larger than 2,400 px on the long edge before upload.
- **Link:** shows title and hostname; click opens the URL in a new tab with `rel="noopener noreferrer"`. No remote fetching of titles or favicons in v1 (the user types the title; default to the hostname).
- **Section:** a large translucent labelled rectangle behind other cards.
- **Folder:** a folder icon with the board's name underneath; rename in place.

### Input shortcuts
- Drop image files onto the canvas to create image cards at the drop point.
- Paste: an image from the clipboard creates an image card; a URL creates a link card; other text creates a note.
- Keys: `Delete` or `Backspace` delete selection; `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z` or `Ctrl+Y` undo and redo; `Ctrl/Cmd+D` duplicate; `Ctrl/Cmd+A` select all; arrow keys nudge; `Esc` clears selection; `F` fits all.
- **Undo and redo:** client-side stack of up to 100 operations per open board; covers create, delete, move, resize, colour, text edits and checklist changes.

### Saving
- Changes are batched and sent to `/changes` about 800 ms after the last edit (also immediately on tab hide and before navigating to another board).
- Show "Saving…" then "Saved". If a request fails, keep the pending ops in memory, retry with exponential backoff (up to 30 s), and show "Offline, retrying". Warn with `beforeunload` while unsaved changes exist.
- No offline mode in v1.

### Look and feel
- Dark and light, defaulting to the system setting (`prefers-color-scheme`) with a manual toggle remembered in `localStorage` (wrap in try/catch).
- **Titles** of notes, checklists and sections are larger and bold. Corners are only slightly rounded (4px on cards and controls, 2px on small elements).
- **Match the retne.games visual style:** read `public/styles.css` and reuse its colours and tone where sensible. Use standard system fonts, with one exception: the app name in the top-left corner, "retne.games HUB", uses the site's Perfect DOS VGA 437 pixel font at 16px. Nothing else uses that font (it can't render all characters). No external fonts.
- Touch targets at least 44 px. Visible keyboard focus. `aria-label` on icon buttons. Respect `prefers-reduced-motion`.
- Must be usable on a phone (about 390 px wide) and on desktop.

---

## 7. Home screen

There is no special home screen. The **root board "Home"** is an ordinary canvas, so the owner can place folder cards (Art, Story, and so on) and notes on it. The breadcrumb's first item always returns to it.

---

## 8. Security requirements

These apply in addition to `CLAUDE.md`.

1. No secrets in any tracked file or anything under `public/`. This spec requires none.
2. Every `/hub` and `/hub/*` request verifies the Access JWT, audience, issuer, expiry and allowed email (section 3). Verification code gets unit-style checks (valid, expired, wrong audience, wrong email, wrong signature) before shipping.
3. **No `innerHTML`, `outerHTML` or `insertAdjacentHTML` with any user-controlled data.** Build DOM with `createElement` and `textContent`. Validate URLs to `http` or `https` only before putting them in `href`.
4. Hub responses (`/hub` and `/hub/*`) get their own `Content-Security-Policy`: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`. Other pages keep the current CSP unchanged. Because `style-src 'self'` blocks inline `style="…"` attributes and `<style>` blocks, **never write inline styles in HTML or via `setAttribute('style', …)`**. Setting styles from JavaScript through `element.style.left = …` or `element.style.setProperty(…)` is allowed and is how cards are positioned.
5. Keep the existing security headers (`nosniff`, `X-Frame-Options`, HSTS, `Referrer-Policy`, `Permissions-Policy`) on hub responses.
6. API responses `Cache-Control: no-store`; image responses as in section 5.
7. Origin and content-type checks on all mutating requests (section 3). Enforce body and field limits before parsing or storing.
8. SQL only through prepared statements with bound parameters.
9. No new third-party scripts, styles, fonts or CDNs.
10. Keep `"workers_dev": false` and `"preview_urls": true` with their explanatory comments in `wrangler.jsonc`. Do not change the Previews-only Access scope.
11. `.dev.vars` and `.wrangler/` stay git-ignored.

---

## 9. Environments and workflow

Follow the workflow in `CLAUDE.md` after each piece of finished work: security review, then commit and push to `main`, then `npx wrangler versions upload --preview-alias staging`, then **stop and wait for the owner's approval** before `npx wrangler versions deploy <version-id>@100% --yes`.

Practical points:
- **Windows PowerShell:** the owner's `npx` needs `npx.cmd` unless execution policy is relaxed (it already is for the current user).
- **Migrations:** apply locally with `npx wrangler d1 migrations apply retne-hub --local`, and to the real database with `--remote` **before** deploying code that needs the new schema. Always tell the owner before running a `--remote` migration.
- **Staging uses the real data.** Preview versions share the production D1 database and R2 bucket. While testing on staging, create test boards named with a `TEST` prefix and remove them afterwards. Migrations must be additive and backward compatible so the live version keeps working while a staged version is being tested.
- **Local dev:** `npx wrangler dev` with `DEV_AUTH_BYPASS=true` in `.dev.vars`. Local D1 and R2 are simulated and separate from production.
- **Contact form** can't be tested on staging (existing limitation); leave it untouched.

---

## 10. Milestones

Each milestone ends with a staging upload and owner approval.

1. **Foundation:** `wrangler.jsonc` bindings and vars, migration `0001`, Access JWT verification, hub routing and CSP, boards API, root board creation, a minimal page that loads and shows the breadcrumb. Verify that a request without a valid token gets 403 and that the contact form still works.
2. **Canvas core:** pan and zoom (mouse and touch), note cards, move, resize, select, delete, autosave with the status indicator, folder cards with nested boards, breadcrumb navigation and URL hash.
3. **Cards and input:** checklist (with the ordering rule), image upload and serving, link and section cards, colours, context menu, drag-drop and paste, undo and redo, keyboard shortcuts.
4. **Polish:** dark and light themes matching the site, phone usability pass, export and import, fit-all, reduced-motion, accessibility labels, error states, empty states.

---

## 11. Acceptance criteria

- Opening `https://retne.games/hub/` while logged out shows the Cloudflare Access login; after GitHub login the app loads. `https://retne.games/` remains public and unchanged. A direct API call without a valid Access token returns 403.
- A board with notes, checklists, images, links, sections and folder cards persists after a reload, and appears identically on the phone after login.
- Double-clicking a folder opens a blank nested board; the breadcrumb and browser back return to the parent; the folder's name stays in sync with the board name.
- Checklist: ticking an entry moves it to the bottom in grey; unticking moves it to the top of the unticked entries; unticked entries are always above ticked ones, including after a reload.
- Dropping an image file or pasting an image creates an image card. A `.svg` or non-image file is rejected with a clear message. An image over 10 MB is rejected.
- Pan, zoom, pinch, marquee selection, resize, undo and redo work on desktop; pan, pinch-zoom, move and edit work on a phone.
- Closing the tab immediately after an edit does not lose the edit (or a warning was shown).
- Export produces a JSON file; importing it creates the boards as a new folder under Home without altering existing boards.
- No inline `style=` attributes or inline scripts anywhere in `public/hub/`; the browser console shows no CSP violations.
- `/api/contact` behaves exactly as before.

---

## 12. Open items for the owner

1. **Previews Access AUD tag** (for staging tests of the hub): the Previews-only Access application has a different AUD tag. Until it is added to `ACCESS_AUDIENCES`, the hub API will return 403 on the staging link; production is unaffected. Get it from Zero Trust → Access controls → Applications → (the Previews application) → Overview.
2. **Production AUD** confirmation: the value in section 1 was read from the login URL. The first deployment should log (privately, not to the client) whether the audience check passes.
3. **Policy cleanup:** the `Martin only` Access policy should end up containing only `admin@retne.games`.
4. **Images in backups:** the JSON export does not include image bytes (they stay in R2). D1 point-in-time restore (Time Travel) covers the database; its retention depends on the Cloudflare plan.
