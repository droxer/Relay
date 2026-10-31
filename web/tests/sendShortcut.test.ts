import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sendShortcutLabel } from "../src/lib/sendShortcut.js";

describe("sendShortcutLabel", () => {
  it("labels Enter as the send shortcut", () => {
    const label = sendShortcutLabel();
    assert.equal(label, "Enter");
  });
});
