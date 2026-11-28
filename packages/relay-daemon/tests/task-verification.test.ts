import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { verificationCandidate, verifyTaskCandidate } from "../src/task-verification.js";

function repository(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "relay-verification-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  git(directory, "init", "-q");
  git(directory, "config", "user.name", "Relay Test");
  git(directory, "config", "user.email", "relay@example.test");
  git(directory, "config", "commit.gpgsign", "false");
  return directory;
}

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

test("the required check uses the owner's script and only the candidate commit's files", { skip: process.platform === "win32" }, async (t) => {
  const source = repository(t);
  writeFileSync(join(source, "check.sh"), 'test "$(cat export.txt)" = good\n');
  writeFileSync(join(source, "export.txt"), "bad");
  git(source, "add", ".");
  git(source, "commit", "-qm", "Pin independent assertion");
  const check = { commit: git(source, "rev-parse", "HEAD"), path: "check.sh" };
  const guest = async (inputs: string) => {
    const checkout = repository(t);
    const commit = readFileSync(join(inputs, "commit"), "utf8");
    execFileSync("git", ["index-pack", "--stdin"], { cwd: checkout, input: readFileSync(join(inputs, "candidate.pack")) });
    writeFileSync(join(checkout, ".git", "shallow"), commit);
    git(checkout, "reset", "--hard", commit.trim());
    const result = spawnSync("bash", [join(inputs, "check.sh")], { cwd: checkout, encoding: "utf8" });
    assert.equal(git(checkout, "rev-parse", "HEAD"), commit.trim());
    return { exit_code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  };

  const failing = await verificationCandidate(source);
  writeFileSync(join(source, "export.txt"), "good");
  assert.equal((await verifyTaskCandidate(source, failing, check, guest)).status, "failed");
  writeFileSync(join(source, "check.sh"), "exit 1\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "Repair export and edit candidate copy of the check");
  const passing = await verificationCandidate(source);
  assert.notEqual(failing, passing);
  assert.equal((await verifyTaskCandidate(source, failing, check, guest)).status, "error");
  const result = await verifyTaskCandidate(source, passing, check, guest);
  assert.equal(result.status, "passed");
  assert.equal(result.candidateCommit, passing);
});
