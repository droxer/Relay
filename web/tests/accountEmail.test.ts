import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidEmailAddress, emailProblem, MAX_EMAIL_LENGTH } from "../src/lib/email.js";

describe("account email", () => {
  it("accepts a plain address, trimming surrounding space and case", () => {
    for (const good of ["ada@example.com", " Ada@Example.com ", "a.b+c@example.co.uk"]) {
      assert.equal(isValidEmailAddress(good), true, good);
    }
  });

  it("refuses the shapes the backend refuses", () => {
    for (const bad of [
      "",
      "not-an-email",
      "a@b", // no dot in the domain
      "a b@example.com", // whitespace in the local part
      "a@exa mple.com", // whitespace in the domain
      'a,"b"@example.com', // characters that could smuggle a second recipient
      `a${"x".repeat(MAX_EMAIL_LENGTH)}@example.com`, // over the length cap
    ]) {
      assert.equal(isValidEmailAddress(bad), false, bad);
    }
  });

  it("names why an address would be refused", () => {
    assert.equal(emailProblem(""), "required");
    assert.equal(emailProblem("   "), "required");
    assert.equal(emailProblem("not-an-email"), "invalid");
    assert.equal(emailProblem("ada@example.com"), null);
  });
});
