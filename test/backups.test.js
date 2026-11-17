import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { backupName, isBackupName, keysToPrune, restoredName } from "../src/hub/backups.js";

describe("backups", () => {
  it("names a backup by its UTC time, so names sort by time", () => {
    const name = backupName(new Date(Date.UTC(2026, 10, 17, 3, 17, 5)));

    assert.equal(name, "retne-hub-2026-11-17-031705.json");
    assert.equal(isBackupName(name), true);
    assert.equal(restoredName(name), "Backup 2026-11-17 03:17 UTC");
  });

  it("only accepts its own names (no paths)", () => {
    assert.equal(isBackupName("../images/x.json"), false);
    assert.equal(isBackupName("retne-hub-2026-11-17.json"), false);
    assert.equal(isBackupName("retne-hub-2026-11-17-031705.json/x"), false);
    assert.equal(isBackupName(undefined), false);
  });

  it("prunes all but the newest", () => {
    const keys = [3, 1, 4, 2, 5].map((day) => `backups/retne-hub-2026-11-0${day}-031700.json`);

    assert.deepEqual(keysToPrune(keys, 3), [
      "backups/retne-hub-2026-11-02-031700.json",
      "backups/retne-hub-2026-11-01-031700.json"
    ]);
    assert.deepEqual(keysToPrune(keys.slice(0, 2), 3), []);
  });
});
