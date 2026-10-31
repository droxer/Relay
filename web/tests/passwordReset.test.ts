import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  completedReset,
  forgetCompletedReset,
  MAX_RESET_IDENTIFIER_LENGTH,
  rememberCompletedReset,
  resetIdentifierProblem,
  resetTokenFromHash,
} from "../src/lib/passwordReset.js";
import { parseAppPath, pathForAppState, validatedReturnTo } from "../src/lib/appRoute.js";

describe("password reset request form", () => {
  it("accepts a username or an email and refuses only the empty or oversized", () => {
    assert.equal(resetIdentifierProblem("ada"), null);
    assert.equal(resetIdentifierProblem(" ada@example.com "), null);
    assert.equal(resetIdentifierProblem("   "), "required");
    assert.equal(resetIdentifierProblem("x".repeat(MAX_RESET_IDENTIFIER_LENGTH + 1)), "too_long");
  });
});

describe("password reset link", () => {
  it("reads the token from the fragment and nothing else", () => {
    assert.equal(resetTokenFromHash("#token=abc_DEF-123"), "abc_DEF-123");
    assert.equal(resetTokenFromHash(""), null);
    assert.equal(resetTokenFromHash("#token="), null);
    assert.equal(resetTokenFromHash("#token=has space"), null);
  });
});

describe("password reset hand-off to sign-in", () => {
  afterEach(() => forgetCompletedReset());

  it("remembers whose password changed until sign-in forgets it", () => {
    assert.equal(completedReset(), null);
    rememberCompletedReset("ada");
    assert.equal(completedReset(), "ada");
    assert.equal(completedReset(), "ada", "reading it twice (StrictMode) must not lose it");
    forgetCompletedReset();
    assert.equal(completedReset(), null);
  });
});

describe("password reset routes", () => {
  it("parses both public pages and writes them back", () => {
    assert.equal(parseAppPath("/forgot-password").publicPage, "forgot-password");
    assert.equal(parseAppPath("/reset-password").publicPage, "reset-password");
    assert.equal(
      pathForAppState({ route: "main", mobileView: "chat", sessionId: null, publicPage: "reset-password" }),
      "/reset-password",
    );
  });

  it("never returns a signed-in user to a reset page", () => {
    assert.equal(validatedReturnTo("/forgot-password"), "/home");
    assert.equal(validatedReturnTo("/reset-password"), "/home");
  });
});
