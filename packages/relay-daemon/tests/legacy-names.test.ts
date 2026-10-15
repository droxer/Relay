import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isUserIdFlag, legacyUserId, userIdFromEnv } from "../src/legacy-names.js";

describe("pre-rename employee names", () => {
  it("prefers RELAY_USER_ID and falls back to RELAY_EMPLOYEE_ID", () => {
    assert.equal(userIdFromEnv({ RELAY_USER_ID: "alice", RELAY_EMPLOYEE_ID: "old" }), "alice");
    assert.equal(userIdFromEnv({ RELAY_EMPLOYEE_ID: "alice" }), "alice");
    assert.equal(userIdFromEnv({}), undefined);
  });

  it("accepts both spellings of the user id flag", () => {
    assert.equal(isUserIdFlag("--user-id"), true);
    assert.equal(isUserIdFlag("--employee-id"), true);
    assert.equal(isUserIdFlag("--workspace"), false);
  });

  it("reads a saved enrollment that still says employeeId", () => {
    assert.equal(legacyUserId({ userId: "alice", employeeId: "old" }), "alice");
    assert.equal(legacyUserId({ employeeId: "alice" }), "alice");
    assert.equal(legacyUserId({ userId: "" }), undefined);
  });
});
