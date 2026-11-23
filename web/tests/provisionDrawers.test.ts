import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolve } from "node:path";

import {
  userHandleOf,
  handleForUserId,
  handleRestatesName,
  isValidUserHandle,
  normalizeUserHandle,
} from "../src/lib/userHandle.js";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  isValidPassword,
  passwordProblem,
} from "../src/lib/passwordPolicy.js";

const readWeb = (path: string) => readFileSync(resolve("web", path), "utf8");

describe("user handle grammar", () => {
  it("normalizes decoration, spacing, and case so the preview cannot lie", () => {
    assert.equal(normalizeUserHandle("  @Alice  "), "alice");
    assert.equal(normalizeUserHandle("@@bob"), "bob");
    assert.equal(normalizeUserHandle(""), "");
  });

  it("mirrors the backend pattern in relay/api/helpers.py", () => {
    for (const good of ["alice", "a1", "alice.chen", "alice-chen", "a_b"]) {
      assert.equal(isValidUserHandle(good), true, good);
    }
    // Too short, spaces, slashes, and leading punctuation are the shapes that
    // would make two spellings look like one identity in a path or an @handle.
    for (const bad of ["a", "alice chen", "alice/bob", "-alice", ".x", "Alice"]) {
      assert.equal(isValidUserHandle(bad), false, bad);
    }
  });
});

describe("owner handle beside the name", () => {
  it("drops a handle that only restates the display name", () => {
    assert.equal(handleRestatesName("alice", "alice"), true);
    assert.equal(handleRestatesName("@Alice ", "alice"), true);
  });

  it("keeps a handle that adds to the name", () => {
    assert.equal(handleRestatesName("Alice Chen", "alice"), false);
    assert.equal(handleRestatesName(undefined, "alice"), false);
    assert.equal(handleRestatesName("", "alice"), false);
  });

  it("names a computer's owner once, never name and handle side by side", () => {
    const owner = readWeb("src/components/admin/NodeOwner.tsx");
    assert.match(owner, /label = name && !handleRestatesName\(name, handle\) \? name : `@\$\{handle\}`/);
    assert.doesNotMatch(owner, /adm-node-owner-handle/);
  });
});

describe("provision drawers", () => {
  it("never offers the admin's own autofill for an account they are editing", () => {
    const source = readWeb("src/components/admin/EditUserDrawer.tsx");
    for (const value of ["\"username\"", "\"email\"", "\"new-password\""]) {
      assert.ok(
        !source.includes(`autoComplete=${value}`),
        `EditUserDrawer must not autofill ${value} into someone else's account`,
      );
    }
  });
});

describe("password policy", () => {
  it("mirrors the backend bounds in relay/security/passwords.py", () => {
    const py = readFileSync(resolve("backend/relay/security/passwords.py"), "utf8");
    assert.match(py, new RegExp(`MIN_PASSWORD_LENGTH = ${MIN_PASSWORD_LENGTH}\\b`));
    assert.match(py, new RegExp(`MAX_PASSWORD_LENGTH = ${MAX_PASSWORD_LENGTH}\\b`));
  });

  it("refuses what the backend refuses, for the same stated reason", () => {
    assert.equal(passwordProblem("short"), "short");
    assert.equal(passwordProblem("x".repeat(MAX_PASSWORD_LENGTH + 1)), "long");
    assert.equal(passwordProblem("aaaaaaaa"), "degenerate");
    assert.equal(passwordProblem("qwertyuiop"), "degenerate");
    // The account's own names are the first guesses anyone makes.
    assert.equal(
      passwordProblem("alice-in-wonderland", ["alice", "Alice Chen"]),
      "identifier",
    );
    assert.equal(passwordProblem("chen-was-here-2026", ["Alice Chen"]), "identifier");
    // The shared email domain is not an identifier — it would reject far too much.
    assert.equal(passwordProblem("example-of-a-fine-one", ["zoe@example.com"]), null);
    // A two-letter handle is skipped for the same reason.
    assert.equal(passwordProblem("something-ordinary-88", ["jo"]), null);
  });

  it("keeps no composition rules — a plain passphrase passes", () => {
    assert.equal(passwordProblem("correct horse battery staple"), null);
    assert.equal(isValidPassword("kestrel-vault-7719"), true);
  });

  it("leaves the blocklist to the backend rather than duplicating it", () => {
    const ts = readFileSync(resolve("web/src/lib/passwordPolicy.ts"), "utf8");
    assert.ok(
      !ts.includes("letmein") && !ts.includes("trustno1"),
      "the common-password list must not be mirrored into the client, where it would drift",
    );
    // ...and the backend must actually carry it.
    const py = readFileSync(resolve("backend/relay/security/passwords.py"), "utf8");
    assert.match(py, /COMMON_PASSWORDS/);
  });
});
