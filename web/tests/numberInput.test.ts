import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { numberFromDraft, draftFromNumber } from "../src/lib/numberInput.js";

/* The limit fields keep a string draft — "" is a real value there ("use the
   org default"), not zero — while the number field works in number | null. */
describe("number input draft", () => {
  it("reads an empty draft as no value, never as zero", () => {
    assert.equal(numberFromDraft(""), null);
    assert.equal(numberFromDraft("   "), null);
  });

  it("reads a numeric draft as its number", () => {
    assert.equal(numberFromDraft("0"), 0);
    assert.equal(numberFromDraft("12"), 12);
  });

  it("reads a draft that is not a number as no value", () => {
    assert.equal(numberFromDraft("abc"), null);
  });

  it("writes a cleared field back as an empty draft", () => {
    assert.equal(draftFromNumber(null), "");
    assert.equal(draftFromNumber(0), "0");
    assert.equal(draftFromNumber(7), "7");
  });
});
