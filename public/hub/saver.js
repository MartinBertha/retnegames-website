// Autosave queue (docs/hub-spec.md, section 6 "Saving"). Card changes are
// coalesced per card (the latest state wins) and sent to /changes about 800 ms
// after the last edit, one request at a time. Failed requests keep their ops
// and retry with exponential backoff up to 30 s. A batch the server rejects
// is sent again card by card, so one bad card doesn't take the others with
// it. Queues are per board, so
// changes still save after navigating to another board.
//
// Conflicts: the saver remembers, per card, the stored version (its
// updatedAt and content) that local changes are made from, and sends that
// updatedAt as each upsert's `base`. When the server says a card has changed
// since (another device saved it), onConflicts gets the three versions to
// merge (merge.js); the merged card is queued again with the new base.

import { sameCard } from "./merge.js";

const DEBOUNCE_MS = 800;
const MAX_OPS_PER_REQUEST = 100;
const MAX_REQUEST_BYTES = 200 * 1024;
const MAX_KEEPALIVE_BYTES = 60 * 1024;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

// Rejected by the server for good: retrying can't help.
const PERMANENT_STATUSES = new Set([400, 404, 409, 413, 415]);

const opKey = (op) => (op.op === "delete" ? op.id : op.item.id);

const cardState = ({ id, type, x, y, w, h, z, color, data }) => structuredClone({ id, type, x, y, w, h, z, color, data });

export class Saver {
  // save(boardId, ops, { keepalive }) -> Promise<{ rev, updatedAt, conflicts }>
  // onStatus(state): "saved" | "saving" | "offline" | "expired" | "error"
  // onSaved(boardId, rev), onRejected(error, boardId)
  // onConflicts(boardId, [{ id, base, local, server, deleted }])
  constructor({ save, onStatus, onSaved, onRejected, onConflicts }) {
    this.save = save;
    this.onStatus = onStatus;
    this.onSaved = onSaved;
    this.onRejected = onRejected;
    this.onConflicts = onConflicts;
    this.pending = new Map();
    this.inFlight = null;
    this.debounceTimer = null;
    this.retryTimer = null;
    this.retryDelay = 0;
    this.failure = null;
    this.rejected = false;
    // id -> { updatedAt, item }: the stored version local changes are made from.
    this.bases = new Map();
    // id -> item: sent, but the answer never came (the connection dropped).
    // A conflict with exactly this is this device's own save.
    this.unconfirmed = new Map();
    this.updateStatus();
  }

  // Cards as the server has them now (a board was loaded or fetched again).
  // Cards with changes still to save keep the base those changes came from.
  remember(items) {
    for (const item of items) {
      if (Number.isSafeInteger(item.updatedAt) && !this.isQueued(item.id)) {
        this.bases.set(item.id, { updatedAt: item.updatedAt, item: cardState(item) });
      }
    }
  }

  isQueued(id) {
    if (this.inFlight?.ops.has(id)) {
      return true;
    }

    for (const board of this.pending.values()) {
      if (board.has(id)) {
        return true;
      }
    }

    return false;
  }

  queue(boardId, ops) {
    if (!ops.length) {
      return;
    }

    let board = this.pending.get(boardId);

    if (!board) {
      board = new Map();
      this.pending.set(boardId, board);
    }

    for (const op of ops) {
      board.delete(opKey(op));
      board.set(opKey(op), structuredClone(op));
    }

    this.updateStatus();

    // While offline the retry timer drives sending.
    if (!this.retryTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.flush(), DEBOUNCE_MS);
    }
  }

  hasUnsaved(boardId) {
    if (boardId === undefined) {
      return this.pending.size > 0 || this.inFlight !== null;
    }

    return Boolean(this.pending.get(boardId)?.size) || this.inFlight?.boardId === boardId;
  }

  // Changes not yet confirmed by the server, oldest first: lets a refetch
  // show local edits on top of the server's copy.
  localOps(boardId) {
    const ops = [];

    if (this.inFlight?.boardId === boardId) {
      ops.push(...this.inFlight.ops.values());
    }

    ops.push(...(this.pending.get(boardId)?.values() ?? []));
    return ops;
  }

  // Sends everything now. Resolves true once all changes are saved.
  async flush({ keepalive = false } = {}) {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;

    for (;;) {
      if (this.inFlight) {
        await this.inFlight.promise;
        continue;
      }

      if (!this.pending.size) {
        return true;
      }

      if (!(await this.sendNext(keepalive))) {
        return false;
      }
    }
  }

  // Takes up to 100 ops / ~200 KB for one board and sends them.
  sendNext(keepalive) {
    const [boardId, board] = this.pending.entries().next().value;
    const ops = new Map();
    let bytes = 0;

    for (const [key, op] of board) {
      const size = JSON.stringify(op).length * 3;

      if (ops.size === MAX_OPS_PER_REQUEST || (ops.size && bytes + size > MAX_REQUEST_BYTES)) {
        break;
      }

      ops.set(key, op);
      bytes += size;
    }

    for (const key of ops.keys()) {
      board.delete(key);
    }

    if (!board.size) {
      this.pending.delete(boardId);
    }

    const promise = this.send(boardId, ops, keepalive && bytes <= MAX_KEEPALIVE_BYTES);
    this.inFlight = { boardId, ops, promise };
    this.updateStatus();
    return promise;
  }

  // One request. Null once saved, the error when the server rejects the ops
  // for good; throws when the server can't be reached.
  async attempt(boardId, ops, keepalive) {
    // Each upsert carries the updatedAt of the version it was made from.
    const sentBases = new Map();
    const request = [...ops.values()].map((op) => {
      if (op.op !== "upsert") {
        return op;
      }

      const base = this.bases.get(op.item.id) ?? null;
      sentBases.set(op.item.id, base);
      return base ? { ...op, base: base.updatedAt } : op;
    });

    try {
      const result = await this.save(boardId, request, { keepalive });
      this.confirm(boardId, ops, sentBases, result ?? {});
      this.onSaved?.(boardId, result?.rev);
      return null;
    } catch (error) {
      if (PERMANENT_STATUSES.has(error?.status)) {
        return error;
      }

      throw error;
    }
  }

  // The server answered for `ops`: saved cards get the new base; cards that
  // changed elsewhere in the meantime go to onConflicts to be merged.
  confirm(boardId, ops, sentBases, { updatedAt, conflicts = [] }) {
    const conflicted = new Map(
      (Array.isArray(conflicts) ? conflicts : [])
        .filter((conflict) => conflict?.item?.id && ops.has(conflict.item.id))
        .map((conflict) => [conflict.item.id, conflict])
    );
    const toMerge = [];

    for (const [id, conflict] of conflicted) {
      const server = cardState(conflict.item);
      const sent = ops.get(id);
      const queued = this.pending.get(boardId)?.get(id);
      const own = this.unconfirmed.get(id);

      this.unconfirmed.delete(id);
      this.bases.set(id, { updatedAt: conflict.item.updatedAt, item: server });

      // Deleted here since: that delete goes ahead.
      if (queued?.op === "delete") {
        continue;
      }

      // Our own earlier save, whose answer was lost: nothing clashed. Send
      // the latest local version again (now with the right base) if it differs.
      if (own && !conflict.deleted && sameCard(own, server)) {
        if (!queued && !sameCard(sent.item, server)) {
          this.queue(boardId, [sent]);
        }

        continue;
      }

      toMerge.push({
        id,
        base: sentBases.get(id)?.item ?? null,
        local: queued?.item ?? sent.item,
        server,
        deleted: Boolean(conflict.deleted)
      });
    }

    for (const [id, op] of ops) {
      if (conflicted.has(id)) {
        continue;
      }

      this.unconfirmed.delete(id);

      // An older server doesn't say when it saved; the next change has no base.
      if (!Number.isSafeInteger(updatedAt)) {
        this.bases.delete(id);
      } else if (op.op === "upsert") {
        this.bases.set(id, { updatedAt, item: op.item });
      } else if (this.bases.has(id)) {
        // Deleted now: undoing the delete is made from this version.
        this.bases.set(id, { updatedAt, item: this.bases.get(id).item });
      }
    }

    if (toMerge.length) {
      this.onConflicts?.(boardId, toMerge);
    }
  }

  reject(error, boardId) {
    this.onRejected?.(error, boardId);

    if (error.status === 404) {
      this.pending.delete(boardId);
    }
  }

  // Saves ops, removing each from `ops` once the server has answered for it.
  // A batch the server rejects for good is sent again one card at a time, so
  // only the cards it won't take are lost. Returns true if any were rejected;
  // throws when the server can't be reached (what's left in `ops` is unsent).
  async deliver(boardId, ops, keepalive) {
    const error = await this.attempt(boardId, ops, keepalive);

    if (!error) {
      ops.clear();
      return false;
    }

    // A missing board (404) rejects everything sent to it.
    if (ops.size === 1 || error.status === 404) {
      ops.clear();
      this.reject(error, boardId);
      return true;
    }

    let rejected = false;

    for (const [key, op] of [...ops]) {
      const single = await this.attempt(boardId, new Map([[key, op]]), keepalive);
      ops.delete(key);

      if (single) {
        rejected = true;
        this.reject(single, boardId);

        if (single.status === 404) {
          ops.clear();
          break;
        }
      }
    }

    return rejected;
  }

  async send(boardId, ops, keepalive) {
    try {
      this.rejected = await this.deliver(boardId, ops, keepalive);
      this.retryDelay = 0;
      this.failure = null;
      return true;
    } catch (error) {
      // Put the unsent ops back unless newer changes to the same cards were queued.
      let board = this.pending.get(boardId);

      if (!board) {
        board = new Map();
        this.pending.set(boardId, board);
      }

      for (const [key, op] of ops) {
        if (!board.has(key)) {
          board.set(key, op);
        }

        // The request may have been saved even though no answer came.
        if (op.op === "upsert") {
          this.unconfirmed.set(key, op.item);
        }
      }

      this.failure = error?.status === 401 || error?.status === 403 ? "expired" : "offline";
      this.retryDelay = Math.min(MAX_RETRY_MS, this.retryDelay ? this.retryDelay * 2 : FIRST_RETRY_MS);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.flush(), this.retryDelay);
      return false;
    } finally {
      this.inFlight = null;
      this.updateStatus();
    }
  }

  updateStatus() {
    let state = "saved";

    if (this.retryTimer || (this.failure && this.hasUnsaved())) {
      state = this.failure ?? "offline";
    } else if (this.hasUnsaved()) {
      state = "saving";
    } else if (this.rejected) {
      state = "error";
    }

    if (state !== this.state) {
      this.state = state;
      this.onStatus?.(state);
    }
  }
}
