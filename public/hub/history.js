// Undo and redo for the open board (docs/hub-spec.md, section 6): up to 100
// steps. Each step holds the cards' states before and after (null = no card).

const LIMIT = 100;
const MERGE_WINDOW_MS = 1000;

export class History {
  constructor(onChange) {
    this.onChange = onChange;
    this.done = [];
    this.undone = [];
  }

  clear() {
    this.done = [];
    this.undone = [];
    this.onChange?.();
  }

  // Steps with the same mergeKey within a second become one (arrow-key nudges).
  push(before, after, mergeKey = null) {
    const last = this.done.at(-1);
    const now = Date.now();

    if (mergeKey && last?.mergeKey === mergeKey && now - last.time < MERGE_WINDOW_MS) {
      for (const [id, state] of after) {
        last.after.set(id, state);
      }

      for (const [id, state] of before) {
        if (!last.before.has(id)) {
          last.before.set(id, state);
        }
      }

      last.time = now;
    } else {
      this.done.push({ before, after, mergeKey, time: now });

      if (this.done.length > LIMIT) {
        this.done.shift();
      }
    }

    this.undone = [];
    this.onChange?.();
  }

  undo() {
    const step = this.done.pop();

    if (step) {
      this.undone.push(step);
      this.onChange?.();
    }

    return step;
  }

  redo() {
    const step = this.undone.pop();

    if (step) {
      this.done.push(step);
      this.onChange?.();
    }

    return step;
  }

  get canUndo() {
    return this.done.length > 0;
  }

  get canRedo() {
    return this.undone.length > 0;
  }
}
