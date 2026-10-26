import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HOST_OS_NAMES, markedHostOs } from "../src/lib/hostOs.js";

describe("markedHostOs", () => {
  it("marks a local computer with the OS its daemon reported", () => {
    for (const os of ["macos", "linux", "windows"] as const) {
      assert.equal(markedHostOs({ hostOs: os, nodeLocation: "user-device" }), os);
    }
  });

  it("marks admin hardware that is not yet assigned", () => {
    assert.equal(markedHostOs({ hostOs: "linux" }), "linux");
  });

  it("leaves a computer unmarked when no OS was reported", () => {
    assert.equal(markedHostOs({ nodeLocation: "user-device" }), null);
  });

  it("leaves a cloud computer unmarked", () => {
    assert.equal(markedHostOs({ hostOs: "linux", nodeLocation: "managed" }), null);
  });

  it("ignores a value it does not know", () => {
    assert.equal(markedHostOs({ hostOs: "beos" as never, nodeLocation: "user-device" }), null);
    assert.equal(markedHostOs({ hostOs: "toString" as never, nodeLocation: "user-device" }), null);
  });

  it("uses each vendor's own product name", () => {
    assert.deepEqual(HOST_OS_NAMES, { macos: "macOS", linux: "Linux", windows: "Windows" });
  });
});
