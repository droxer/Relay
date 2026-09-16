import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRESET_AVATARS,
  isPresetAvatarUrl,
  randomPresetAvatar,
} from "../src/lib/presetAvatars.js";

const AVATARS_DIR = path.join("web", "public", "avatars");

function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, AVATARS_DIR))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`unable to locate ${AVATARS_DIR}`);
    dir = parent;
  }
}

describe("preset avatars", () => {
  it("lists exactly the committed SVGs for each kind", () => {
    const root = findRepoRoot();
    for (const kind of ["agents", "teams"] as const) {
      const onDisk = readdirSync(path.join(root, AVATARS_DIR, kind))
        .filter((name) => name.endsWith(".svg"))
        .map((name) => `/avatars/${kind}/${name}`)
        .sort();
      assert.deepEqual([...PRESET_AVATARS[kind]].sort(), onDisk);
    }
    assert.equal(PRESET_AVATARS.agents.length, 16);
    assert.equal(PRESET_AVATARS.teams.length, 12);
  });

  it("recognises presets only for their own kind", () => {
    assert.equal(isPresetAvatarUrl("agents", "/avatars/agents/bottts-01.svg"), true);
    assert.equal(isPresetAvatarUrl("teams", "/avatars/agents/bottts-01.svg"), false);
    assert.equal(isPresetAvatarUrl("agents", "/profile-images/agents/a1?v=1"), false);
    assert.equal(isPresetAvatarUrl("agents", null), false);
  });

  it("picks a random preset of the requested kind", () => {
    assert.equal(randomPresetAvatar("agents", () => 0), "/avatars/agents/bottts-01.svg");
    assert.equal(randomPresetAvatar("teams", () => 0.9999), "/avatars/teams/shape-grid-12.svg");
    assert.equal(isPresetAvatarUrl("agents", randomPresetAvatar("agents")), true);
  });
});
