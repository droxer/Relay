import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SkillRecord } from "../src/domain-types/skills.js";
import { groupSkillsByFolder, parentFolder, repositoryName } from "../src/lib/skillGroups.js";

function gitSkill(id: string, url: string, subpath: string): SkillRecord {
  return { id, displayName: id, namespace: "", source: "git", sourceRef: { url, ref: "main", subpath } } as SkillRecord;
}

function upload(id: string, namespace = ""): SkillRecord {
  return { id, displayName: id, namespace, source: "upload", sourceRef: null } as SkillRecord;
}

const summary = (skills: SkillRecord[]) =>
  groupSkillsByFolder(skills).map((group) => [group.label, group.repository, group.skills.map((skill) => skill.id)]);

describe("parentFolder / repositoryName", () => {
  it("reads a bundle's parent and a repository's owner/name", () => {
    assert.equal(parentFolder("skills/engineering/tdd"), "skills/engineering");
    assert.equal(parentFolder("tdd"), "");
    assert.equal(parentFolder(""), "");
    assert.equal(repositoryName("https://github.com/acme/skills.git"), "acme/skills");
    assert.equal(repositoryName("not a url"), "not a url");
  });
});

describe("groupSkillsByFolder", () => {
  it("bands repository skills by their bundle's parent folder", () => {
    assert.deepEqual(summary([
      gitSkill("tdd", "https://github.com/acme/skills", "skills/engineering/tdd"),
      gitSkill("triage", "https://github.com/acme/skills", "skills/product/triage"),
      gitSkill("review", "https://github.com/acme/skills", "skills/engineering/review"),
    ]), [
      ["skills/engineering", null, ["review", "tdd"]],
      ["skills/product", null, ["triage"]],
    ]);
  });

  it("bands a root bundle under its repository", () => {
    assert.deepEqual(summary([gitSkill("solo", "https://github.com/acme/solo", "")]), [
      ["acme/solo", null, ["solo"]],
    ]);
  });

  it("names the repository only when two repositories share a folder", () => {
    assert.deepEqual(summary([
      gitSkill("a", "https://github.com/acme/one", "skills/a"),
      gitSkill("b", "https://github.com/acme/two", "skills/b"),
      gitSkill("c", "https://github.com/acme/two", "tools/c"),
    ]), [
      ["skills", "acme/one", ["a"]],
      ["skills", "acme/two", ["b"]],
      ["tools", null, ["c"]],
    ]);
  });

  it("bands uploads by namespace and puts un-namespaced uploads last", () => {
    assert.deepEqual(summary([
      upload("loose"),
      upload("notes", "acme"),
      gitSkill("tdd", "https://github.com/acme/skills", "skills/tdd"),
    ]), [
      ["acme", null, ["notes"]],
      ["skills", null, ["tdd"]],
      [null, null, ["loose"]],
    ]);
  });
});
