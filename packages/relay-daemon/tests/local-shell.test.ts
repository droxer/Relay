import assert from "node:assert/strict";
import { test } from "node:test";
import { GIT_BASH_REQUIRED, gitBashCandidates, localBash, type ShellLookup } from "../src/local-shell.js";

function lookup(env: NodeJS.ProcessEnv, present: string[], git: string[] = []): ShellLookup {
  return { env, exists: path => present.includes(path), gitOnPath: () => git };
}

test("POSIX hosts run agent scripts with bash from PATH", () => {
  assert.equal(localBash("darwin"), "bash");
  assert.equal(localBash("linux"), "bash");
});

test("Windows prefers an explicit bash, then the Git on PATH, then standard Git installs", () => {
  const env = { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" };
  assert.deepEqual(gitBashCandidates(lookup({ ...env, RELAY_BASH_PATH: "D:\\bash.exe" }, [], ["E:\\Git\\cmd\\git.exe"])), [
    "D:\\bash.exe",
    "E:\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Users\\a\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
  ]);
  assert.equal(localBash("win32", lookup(env, ["C:\\Program Files\\Git\\bin\\bash.exe"])), "C:\\Program Files\\Git\\bin\\bash.exe");
});

test("Windows never runs agent scripts in WSL, and says how to get Git Bash", () => {
  const wsl = "C:\\Windows\\System32\\bash.exe";
  assert.throws(() => localBash("win32", lookup({ RELAY_BASH_PATH: wsl }, [wsl])), new Error(GIT_BASH_REQUIRED));
  assert.throws(() => localBash("win32", lookup({}, [])), /Git for Windows/);
});
