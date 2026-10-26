import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { daemonHostOs } from "../src/daemon-node-protocol.js";

describe("daemonHostOs", () => {
  it("names the three platforms a daemon installs on", () => {
    assert.equal(daemonHostOs("darwin"), "macos");
    assert.equal(daemonHostOs("linux"), "linux");
    assert.equal(daemonHostOs("win32"), "windows");
  });

  it("reports nothing for any other platform", () => {
    assert.equal(daemonHostOs("freebsd"), undefined);
    assert.equal(daemonHostOs("aix"), undefined);
  });
});
