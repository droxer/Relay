import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { greetingName, greetingPeriod } from "../src/lib/welcomeRecap.js";

describe("greetingPeriod", () => {
  it("names the part of the day by the local hour", () => {
    assert.equal(greetingPeriod(3), "late");
    assert.equal(greetingPeriod(9), "morning");
    assert.equal(greetingPeriod(14), "afternoon");
    assert.equal(greetingPeriod(20), "evening");
  });
});

describe("greetingName", () => {
  it("greets by the first word of the display name, else the username", () => {
    assert.equal(greetingName({ displayName: "Fei He", username: "fei" }), "Fei");
    assert.equal(greetingName({ displayName: "  ", username: "fei" }), "fei");
    assert.equal(greetingName({ username: "" }), "");
  });
});
