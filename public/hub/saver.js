// Autosave queue (docs/hub-spec.md, section 6 "Saving"). Card changes are
// coalesced per card (the latest state wins) and sent to /changes about 800 ms
// after the last edit, one request at a time. Failed requests keep their ops
// and retry with exponential backoff up to 30 s. Queues are per board, so
// changes still save after navigating to another board.

const DEBOUNCE_MS = 800;
const MAX_OPS_PER_REQUEST = 100;
const MAX_REQUEST_BYTES = 200 * 1024;
const MAX_KEEPALIVE_BYTES = 60 * 1024;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

// Rejected by the server for good: retrying can't help.
const PERMANENT_STATUSES = new Set([400, 404, 409, 413, 415]);

const opKey = (op) => (op.op === "delete" ? op.id : op.item.id);

export class Saver {
  // save(boardId, ops, { keepalive }) -> Promise<{ rev }>
  // onStatus(state): "saved" | "saving" | "offline" | "expired" | "error"
  // onSaved(boardId, rev), onRejected(error, boardId)
  constructor({ save, onStatus, onSaved, onRejected }) {
    this.save = save;
    this.onStatus = onStatus;
    this.onSaved = onSaved;
    this.onRejected = onRejected;
    this.pending = new Map();
    this.inFlight = null;
    this.debounceTimer = null;
    this.retryTimer = null;
    this.retryDelay = 0;
    this.failure = null;
    this.rejected = false;
    this.updateStatus();
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

  async send(boardId, ops, keepalive) {
    try {
      const { rev } = await this.save(boardId, [...ops.values()], { keepalive });
      this.retryDelay = 0;
      this.failure = null;
      this.rejected = false;
      this.onSaved?.(boardId, rev);
      return true;
    } catch (error) {
      if (PERMANENT_STATUSES.has(error?.status)) {
        this.rejected = true;
        this.onRejected?.(error, boardId);

        if (error.status === 404) {
          this.pending.delete(boardId);
        }

        return true;
      }

      // Put the ops back unless newer changes to the same cards were queued.
      let board = this.pending.get(boardId);

      if (!board) {
        board = new Map();
        this.pending.set(boardId, board);
      }

      for (const [key, op] of ops) {
        if (!board.has(key)) {
          board.set(key, op);
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
