import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { configuredProjectRoots, ProjectLinkError, ProjectLinkRegistry } from "../src/project-links.js";
import { ThreadWorkspaceManager } from "../src/thread-workspace.js";

interface Fixture {
  base: string;
  allowed: string;
  workspaceRoot: string;
  stateDir: string;
  registry: ProjectLinkRegistry;
}

function fixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "relay-project-links-")));
  const allowed = join(base, "code");
  const workspaceRoot = join(allowed, "relay-root");
  const stateDir = join(base, "state");
  for (const dir of [allowed, workspaceRoot, stateDir]) mkdirSync(dir, { recursive: true });
  const registry = new ProjectLinkRegistry([allowed], [workspaceRoot, stateDir]);
  return { base, allowed, workspaceRoot, stateDir, registry };
}

function linkErrorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ProjectLinkError, String(error));
    return error.code;
  }
  assert.fail("expected a ProjectLinkError");
}

test("an existing directory inside an allowed root links to its canonical path", () => {
  const { base, allowed, registry } = fixture();
  try {
    const repo = join(allowed, "app");
    mkdirSync(repo);

    assert.equal(registry.link("links/p1", `${repo}/`), repo);
    assert.equal(registry.resolve("links/p1"), repo);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("link validation refuses paths the computer has not allowed", () => {
  const { base, allowed, workspaceRoot, stateDir, registry } = fixture();
  try {
    const outside = join(base, "elsewhere");
    mkdirSync(outside);
    const file = join(allowed, "notes.txt");
    writeFileSync(file, "x");
    const escape = join(allowed, "escape");
    symlinkSync(outside, escape);

    assert.equal(linkErrorCode(() => registry.validate("code/app")), "invalid-path");
    assert.equal(linkErrorCode(() => registry.validate(join(allowed, "missing"))), "not-found");
    assert.equal(linkErrorCode(() => registry.validate(file)), "not-directory");
    assert.equal(linkErrorCode(() => registry.validate(outside)), "not-allowed");
    // A symbolic link is judged by where it points, not where it sits.
    assert.equal(linkErrorCode(() => registry.validate(escape)), "not-allowed");
    // The allowed root contains Relay's own workspace root.
    assert.equal(linkErrorCode(() => registry.validate(allowed)), "protected");
    assert.equal(linkErrorCode(() => registry.validate(stateDir)), "not-allowed");
    // Relay's root holds other threads, projects, and agent homes.
    const inside = join(workspaceRoot, "projects", "other");
    mkdirSync(inside, { recursive: true });
    assert.equal(linkErrorCode(() => registry.validate(inside)), "protected");
    assert.equal(linkErrorCode(() => registry.validate(workspaceRoot)), "protected");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a link may not overlap the daemon's private state", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "relay-project-links-private-")));
  try {
    const stateDir = join(base, "home", ".relay", "daemon-nodes", "node-1");
    mkdirSync(stateDir, { recursive: true });
    const registry = new ProjectLinkRegistry([base], [stateDir]);

    assert.equal(linkErrorCode(() => registry.validate(join(base, "home"))), "protected");
    assert.equal(linkErrorCode(() => registry.validate(stateDir)), "protected");
    if (process.platform === "darwin" || process.platform === "win32") {
      // A case-insensitive volume must not let another spelling slip past.
      assert.equal(linkErrorCode(() => registry.validate(join(base, "home", ".RELAY"))), "protected");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("no allowed roots means linking is disabled with an actionable message", () => {
  const { base, allowed } = fixture();
  try {
    const registry = new ProjectLinkRegistry([], []);
    assert.throws(() => registry.validate(allowed), /RELAY_DAEMON_PROJECT_ROOTS/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("replaceAll keeps valid links and reports the rest", () => {
  const { base, allowed, registry } = fixture();
  try {
    const repo = join(allowed, "app");
    mkdirSync(repo);
    registry.link("links/stale", repo);

    const rejected = registry.replaceAll([
      { workspaceSubpath: "links/p1", hostPath: repo },
      { workspaceSubpath: "links/p2", hostPath: join(base, "elsewhere") },
      { workspaceSubpath: "projects/p3", hostPath: repo },
    ]);

    assert.deepEqual(rejected.map((entry) => entry.workspaceSubpath), ["links/p2", "projects/p3"]);
    assert.equal(registry.resolve("links/p1"), repo);
    assert.equal(linkErrorCode(() => registry.resolve("links/stale")), "not-found");
    // A refused link's runs say why rather than "not linked".
    assert.throws(() => registry.resolve("links/p2"), /no longer accepts the project's directory: No directory exists/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a link that later disappears fails resolution instead of being recreated", () => {
  const { base, allowed, workspaceRoot, registry } = fixture();
  try {
    const repo = join(allowed, "app");
    mkdirSync(repo);
    registry.link("links/p1", repo);
    const manager = new ThreadWorkspaceManager(workspaceRoot, "none", registry);

    assert.equal(manager.ensureSubpath("p1", "links/p1").hostPath, repo);
    rmSync(repo, { recursive: true });

    assert.throws(() => manager.ensureSubpath("p1", "links/p1"), /No directory exists/);
    assert.throws(() => manager.ensureSubpath("p2", "links/unknown"), /not linked on this computer/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("BoxLite mounts a linked directory at the guest workspace root", () => {
  const { base, allowed, workspaceRoot, registry } = fixture();
  try {
    const repo = join(allowed, "app");
    mkdirSync(repo);
    registry.link("links/p1", repo);
    const workspace = new ThreadWorkspaceManager(workspaceRoot, "boxlite", registry).resolveSubpath("p1", "links/p1");

    assert.equal(workspace.hostPath, repo);
    assert.equal(workspace.executionPath, "/workspace");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("project roots default to home on direct-run computers and to nothing in BoxLite", () => {
  const { base, allowed } = fixture();
  try {
    assert.deepEqual(configuredProjectRoots("boxlite", undefined), []);
    assert.equal(configuredProjectRoots("none", undefined).length, 1);
    assert.deepEqual(
      configuredProjectRoots("boxlite", [allowed, "relative/dir", join(base, "missing"), allowed].join(delimiter)),
      [allowed],
    );
    assert.deepEqual(configuredProjectRoots("none", ""), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
