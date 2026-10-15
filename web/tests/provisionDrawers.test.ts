import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolve } from "node:path";

import {
  userHandleOf,
  handleForUserId,
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

describe("provision drawers", () => {
  it("gives the run-mode radio a focusable box instead of hiding the ring", () => {
    // Same invariant, new mechanism. The segment used to be a native radio
    // stretched invisibly across the option purely so base.css's single
    // `input:focus-visible` ring would land on the option's geometry — and
    // `opacity: 0` on that input would have hidden the outline along with the
    // box. The option is a `<button role="radio">` from the shared RadioGroup
    // now, which base.css rings directly through `button:focus-visible`, so
    // the guard is that no hidden input has come back.
    const source = readWeb("src/components/admin/RunModeField.tsx");
    assert.ok(
      source.includes("RadioGroupChoice"),
      "the run-mode segment must go through the shared radio group",
    );
    assert.ok(
      !source.includes('type="radio"'),
      "a hand-rolled native radio cannot carry the shared focus ring here",
    );
    const css = readWeb("src/styles/admin-v2-provision.css");
    assert.ok(
      !css.includes(".adm-profile-segment-input"),
      "the stretched-input trick is obsolete — remove its rule with it",
    );
  });

  it("does not print an error string as a resting hint", () => {
    const source = readWeb("src/components/admin/AddNodeDrawer.tsx");
    const hint = source.slice(source.indexOf("adm-form-hint\">"));
    assert.ok(
      !hint.includes("admin.user_required"),
      "the assignment hint must be guidance, not the field's own error text",
    );
  });

  it("says what handle will be stored when it differs from what was typed", () => {
    // The preview card is gone; the id field's hint carries the same promise
    // — `@Alice` is not what gets stored — without announcing per keystroke.
    const source = readWeb("src/components/admin/AddUserDrawer.tsx");
    assert.match(source, /normalizedHandle !== userId\.trim\(\)/);
    assert.match(source, /admin\.v2\.user_id_normalized/);
    assert.ok(!source.includes("adm-provision-preview"), "the preview card must not come back");
    assert.ok(!source.includes("aria-live"), "the hint must not announce on every character");
  });

  it("never offers the admin's own autofill for an account they are creating", () => {
    for (const path of [
      "src/components/admin/AddUserDrawer.tsx",
      "src/components/admin/EditUserDrawer.tsx",
    ]) {
      const source = readWeb(path);
      for (const value of ["\"username\"", "\"email\"", "\"new-password\""]) {
        assert.ok(
          !source.includes(`autoComplete=${value}`),
          `${path} must not autofill ${value} into someone else's account`,
        );
      }
    }
  });

  it("focuses every field it validates", () => {
    const source = readWeb("src/components/admin/AddUserDrawer.tsx");
    const chain = source.slice(source.indexOf("const firstInvalid"), source.indexOf("if (firstInvalid)"));
    for (const field of ["userId", "maxLocalComputers", "username", "password"]) {
      assert.ok(chain.includes(field), `${field} is validated but never focused`);
    }
  });

  it("marks the created computer in the list it lands in", () => {
    const admin = readWeb("src/components/AdminPage.tsx");
    assert.match(admin, /highlightedNodeId/);
    // Both node paths switch to the Computers view, where a user-keyed
    // pulse is never read.
    assert.match(admin, /function handleCreateManagedNodeSuccess[\s\S]{0,400}pulseNode\(node\.id\)/);
    assert.match(admin, /function handleCreateManualNodeSuccess[\s\S]{0,600}pulseNode\(node\.id\)/);
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
