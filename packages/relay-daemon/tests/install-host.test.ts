import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isOnPath, launchdBootstrapError, lingerNotice, macProtectedFolder, pathNotice, startupFileAddingDir } from "../src/install-notices.js";
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

  it("finds the launcher directory on PATH however the entry is spelled", () => {
    assert.equal(isOnPath("/Users/ana/.local/bin", "/usr/bin:/Users/ana/.local/bin/:/bin", "darwin"), true);
    assert.equal(isOnPath("/Users/ana/.local/bin", "/usr/bin:/bin", "darwin"), false);
    assert.equal(isOnPath("/Users/ana/.local/bin", "/Users/ana/.local/bin2", "linux"), false);
    assert.equal(isOnPath("/Users/ana/.local/bin", undefined, "linux"), false);
    assert.equal(isOnPath("C:\\Users\\Ana\\.local\\bin", "C:\\Windows;\"c:\\users\\ana\\.local\\bin\\\"", "win32"), true);
    assert.equal(isOnPath("C:\\Users\\Ana\\.local\\bin", "C:\\Windows", "win32"), false);
  });

  it("tells the user how to put the launcher on PATH in their own shell", () => {
    const base = { binDir: "/Users/ana/.local/bin", home: "/Users/ana", command: "relay" };
    const zsh = pathNotice({ ...base, platform: "darwin", shell: "/bin/zsh" });
    assert.match(zsh, /\/Users\/ana\/\.local\/bin is not on your PATH/);
    assert.match(zsh, /echo 'export PATH="\$HOME\/\.local\/bin:\$PATH"' >> ~\/\.zshrc/);
    assert.match(pathNotice({ ...base, platform: "darwin", shell: "/bin/bash" }), />> ~\/\.bash_profile/);
    assert.match(pathNotice({ ...base, platform: "linux", shell: "/usr/bin/bash" }), />> ~\/\.bashrc/);
    assert.match(pathNotice({ ...base, platform: "linux", shell: "/usr/bin/fish" }), /fish_add_path ~\/\.local\/bin/);
    assert.match(pathNotice({ ...base, platform: "linux", shell: undefined }), />> ~\/\.profile/);
    assert.match(pathNotice({ ...base, binDir: "/opt/relay/bin", platform: "linux", shell: "/bin/zsh" }), /export PATH="\/opt\/relay\/bin:\$PATH"/);
    const windows = pathNotice({ binDir: "C:\\Users\\Ana\\.local\\bin", home: "C:\\Users\\Ana", command: "relay", platform: "win32", shell: undefined });
    assert.match(windows, /\[Environment\]::SetEnvironmentVariable\('Path', 'C:\\Users\\Ana\\\.local\\bin;' \+ \[Environment\]::GetEnvironmentVariable\('Path', 'User'\), 'User'\)/);
  });

  it("says to log in again when a startup file already adds the directory once it exists", () => {
    const base = { binDir: "/home/ana/.local/bin", home: "/home/ana", command: "relay" };
    const ubuntu = pathNotice({ ...base, platform: "linux", shell: "/bin/bash", configuredIn: "~/.profile" });
    assert.match(ubuntu, /~\/\.profile already adds it/);
    assert.match(ubuntu, /log out and back in/);
    assert.doesNotMatch(ubuntu, /echo/);
    assert.match(pathNotice({ ...base, platform: "linux", shell: "/bin/zsh", configuredIn: "~/.zshrc" }), /open a new terminal/);
    assert.match(pathNotice({ ...base, platform: "darwin", shell: "/bin/zsh", configuredIn: "~/.zprofile" }), /open a new terminal/);
  });

  it("finds the startup file of the user's shell that adds the directory", () => {
    const files: Record<string, string> = {
      "/home/ana/.profile": 'if [ -d "$HOME/.local/bin" ] ; then\n    PATH="$HOME/.local/bin:$PATH"\nfi\n',
      "/home/ana/.zshrc": "export EDITOR=vim\n",
    };
    const read = (file: string) => files[file];
    const args = { binDir: "/home/ana/.local/bin", home: "/home/ana", platform: "linux" };
    assert.equal(startupFileAddingDir({ ...args, shell: "/bin/bash" }, read), "~/.profile");
    assert.equal(startupFileAddingDir({ ...args, shell: "/bin/sh" }, read), "~/.profile");
    // zsh never reads ~/.profile.
    assert.equal(startupFileAddingDir({ ...args, shell: "/bin/zsh" }, read), undefined);
    assert.equal(startupFileAddingDir({ ...args, platform: "win32", shell: undefined }, read), undefined);
  });

  it("respects Bash login profile precedence, including empty files", () => {
    const args = { binDir: "/home/ana/.local/bin", home: "/home/ana", platform: "linux", shell: "/bin/bash" };
    const files: Record<string, string> = {
      "/home/ana/.bash_profile": "",
      "/home/ana/.bash_login": 'export PATH="$HOME/.local/bin:$PATH"\n',
      "/home/ana/.profile": 'export PATH="$HOME/.local/bin:$PATH"\n',
    };
    const read = (file: string) => files[file];
    assert.equal(startupFileAddingDir(args, read), undefined);
    delete files["/home/ana/.bash_profile"];
    assert.equal(startupFileAddingDir(args, read), "~/.bash_login");
    files["/home/ana/.bash_login"] = "export EDITOR=vim\n";
    assert.equal(startupFileAddingDir(args, read), undefined);
    delete files["/home/ana/.bash_login"];
    assert.equal(startupFileAddingDir(args, read), "~/.profile");
  });

  it("requires an active PATH assignment with an exact directory entry", () => {
    const args = { binDir: "/home/ana/.local/bin", home: "/home/ana", platform: "linux", shell: "/bin/bash" };
    for (const content of [
      '# export PATH="$HOME/.local/bin:$PATH"',
      'export OTHER="$HOME/.local/bin"',
      'export PATH="$HOME/.local/bin2:$PATH"',
      'export PATH="$PATH" # add $HOME/.local/bin later',
      'echo \'PATH="$HOME/.local/bin:$PATH"\'',
      'export PATH=\'$HOME/.local/bin:$PATH\'',
      'export PATH="~/.local/bin:$PATH"',
    ]) {
      const configuredIn = startupFileAddingDir(args, file => file.endsWith('/.bashrc') ? content : undefined);
      assert.equal(configuredIn, undefined, content);
      assert.match(pathNotice({ ...args, command: "relay", configuredIn }), /echo 'export PATH=/);
    }
    for (const content of [
      'export PATH="$HOME/.local/bin:$PATH"',
      '  PATH="${HOME}/.local/bin:$PATH" # launchers',
      'export PATH="$PATH:/home/ana/.local/bin"',
      'PATH=~/.local/bin:$PATH',
      'export PATH=\'/home/ana/.local/bin:/usr/bin\'',
    ]) {
      assert.equal(startupFileAddingDir(args, file => file.endsWith('/.bashrc') ? content : undefined), "~/.bashrc", content);
    }
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
