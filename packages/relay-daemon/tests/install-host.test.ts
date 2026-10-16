import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchdBootstrapError, lingerNotice, macProtectedFolder } from "../src/install-notices.js";
import { installDirectoryOf, installRootOf, pruneInstallDirectories, staleInstallEntries } from "../src/install-pruning.js";
import { sameComputer, workspaceIdentity } from "../src/installed-computers.js";
import { withCurrentPath } from "../src/runtime-profile.js";

const SHA = (digit: string) => digit.repeat(64);

describe("installer platform notices", () => {
  it("flags macOS folders the background service needs permission for", () => {
    assert.equal(macProtectedFolder("/Users/ana", "/Users/ana/Documents/work"), "Documents");
    assert.equal(macProtectedFolder("/Users/ana", "/Users/ana/Desktop"), "Desktop");
    assert.equal(macProtectedFolder("/Users/ana", "/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/x"), "iCloud Drive");
    assert.equal(macProtectedFolder("/Users/ana", "/Volumes/USB/work"), "an external volume");
    assert.equal(macProtectedFolder("/Users/ana", "/Users/ana/work"), undefined);
    assert.equal(macProtectedFolder("/Users/ana", "/Users/ana/DocumentsArchive"), undefined);
  });

  it("explains Linux logout only while linger is off", () => {
    assert.match(lingerNotice("no\n", "ana", "Relay")!, /sudo loginctl enable-linger ana/);
    assert.equal(lingerNotice("yes\n", "ana", "Relay"), undefined);
    assert.equal(lingerNotice(undefined, "ana", "Relay"), undefined);
  });

  it("tells an SSH user why launchd refused, and what to do", () => {
    assert.match(launchdBootstrapError({ SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }, "Relay"), /--foreground/);
    assert.match(launchdBootstrapError({ SSH_CONNECTION: "x" }, "Relay"), /over SSH/);
    assert.doesNotMatch(launchdBootstrapError({}, "Relay"), /SSH/);
  });
});

describe("one workspace is one computer however its path is spelled", () => {
  it("resolves symlinks before comparing", () => {
    const root = mkdtempSync(join(tmpdir(), "relay-identity-"));
    try {
      const real = join(root, "real");
      mkdirSync(real);
      symlinkSync(real, join(root, "link"));
      const computer = { id: "a", name: "n", file: "f", backendUrl: "https://relay.example.com", userId: "u", workspace: join(root, "link") };
      assert.equal(sameComputer(computer, "https://relay.example.com/", real), true);
      assert.equal(sameComputer(computer, "https://relay.example.com/", join(root, "other")), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("ignores case on Windows", () => {
    assert.equal(workspaceIdentity("C:\\Work\\Relay", "win32"), workspaceIdentity("c:\\work\\relay", "win32"));
  });
});

describe("pruning old releases and runtimes", () => {
  it("finds the Relay root and the install directory a file lives in", () => {
    const root = "/home/ana/.local/share/relay";
    assert.equal(installRootOf(`${root}/releases/${SHA("a")}/node_modules/relay-daemon/dist/install.js`), root);
    assert.equal(installRootOf("/repo/packages/relay-daemon/dist/install.js"), undefined);
    assert.equal(installDirectoryOf(root, `${root}/runtimes/node-v24.1.0-linux-x64/bin/node`), `${root}/runtimes/node-v24.1.0-linux-x64`);
    assert.equal(installDirectoryOf(root, "/usr/bin/node"), undefined);
  });

  it("keeps what services use and the newest unreferenced few", () => {
    const entries = ["a", "b", "c", "d"].map((name, index) => ({ path: name, mtimeMs: index }));
    assert.deepEqual(staleInstallEntries(entries, new Set(["a"]), 2), ["b"]);
  });

  it("removes only unused release and runtime directories", () => {
    const root = mkdtempSync(join(tmpdir(), "relay-prune-"));
    try {
      const dirs = [SHA("1"), SHA("2"), SHA("3"), SHA("4")].map((sha, index) => {
        const dir = join(root, "releases", sha);
        mkdirSync(join(dir, "node_modules"), { recursive: true });
        utimesSync(dir, index + 1, index + 1);
        return dir;
      });
      mkdirSync(join(root, "releases", "not-a-release"));
      const removed = pruneInstallDirectories(root, [join(dirs[0]!, "node_modules", "relay-daemon", "dist", "cli.js")], () => undefined);
      // dirs[0] is in use; dirs[3] and dirs[2] are the newest unreferenced ones.
      assert.deepEqual(removed, [dirs[1]]);
      assert.equal(existsSync(join(root, "releases", "not-a-release")), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("upgrading keeps the runtime profile's PATH current", () => {
  it("puts the installing shell's PATH first and keeps the rest", () => {
    const profile = { version: 1 as const, environment: { HOME: "/h", PATH: "/usr/bin:/old/bin" } };
    const refreshed = withCurrentPath(profile, "/new/bin:/usr/bin", ":");
    assert.equal(refreshed.environment.PATH, "/new/bin:/usr/bin:/old/bin");
    assert.equal(profile.environment.PATH, "/usr/bin:/old/bin");
    assert.equal(withCurrentPath(profile, undefined, ":"), profile);
  });
});
