import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SkillRecord } from "../src/domain-types/skills.js";
import { groupSkills, searchSkillGroups } from "../src/lib/skillGroups.js";

function skill(name: string, patch: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: name, ownerUserId: "user", name, displayName: name, slug: name, namespace: "", description: "",
    visibility: "private", source: "upload", currentRevisionId: "r", stableRevisionId: "r",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...patch,
  };
}

function gitSkill(name: string, url: string, subpath: string, namespace = "") {
  return skill(name, { namespace, source: "git", sourceRef: { url, ref: "main", subpath } });
}

const summary = (groups: ReturnType<typeof groupSkills>) =>
  groups.map((group) => [group.label, group.qualifier, group.skills.map((item) => item.id)]);

describe("groupSkills", () => {
  it("groups Git, uploaded and authored Skills by the first declared namespace segment", () => {
    assert.deepEqual(summary(groupSkills([
      gitSkill("architect", "https://github.com/acme/pstack", "skills/design/architect", "pstack/design"),
      gitSkill("arena", "https://github.com/acme/pstack", "skills/arena", "pstack"),
      gitSkill("writing-for-agents", "https://github.com/acme/matt-pocock-skills", "skills/productivity/writing-for-agents", "matt-pocock-skills"),
      gitSkill("wait-what", "https://github.com/acme/matt-pocock-skills", "skills/engineering/wait-what", "matt-pocock-skills"),
      skill("review", { namespace: "pstack", slug: "skill-3/pstack/review" }),
      skill("draft", { namespace: "pstack/editorial", source: "authored" }),
    ])), [
      ["matt-pocock-skills", null, ["wait-what", "writing-for-agents"]],
      ["pstack", null, ["architect", "arena", "draft", "review"]],
    ]);
  });

  it("groups Git bundles by repository across folders, case and URL suffixes", () => {
    assert.deepEqual(summary(groupSkills([
      gitSkill("tdd", "https://github.com/acme/skills", "skills/engineering/tdd"),
      gitSkill("triage", "https://github.com/Acme/skills.git/", "skills/product/triage"),
      gitSkill("root", "https://github.com/acme/SKILLS", ""),
    ])), [["skills", null, ["root", "tdd", "triage"]]]);
  });

  it("qualifies colliding repository names and retains their owner label when filtering", () => {
    const groups = groupSkills([
      gitSkill("tdd", "https://github.com/acme/review", "engineering/tdd"),
      gitSkill("triage", "https://github.com/example/Review", "product/triage"),
      skill("edit", { namespace: "review" }),
    ]);
    assert.deepEqual(summary(groups), [
      ["review", null, ["edit"]],
      ["review", "acme", ["tdd"]],
      ["Review", "example", ["triage"]],
    ]);
    assert.deepEqual(summary(searchSkillGroups(groups, "example/review", "Ungrouped")), [
      ["Review", "example", ["triage"]],
    ]);
  });

  it("puts Skills without a namespace or a valid Git source last", () => {
    const groups = groupSkills([
      skill("notes", { slug: "user/notes", source: "authored" }),
      gitSkill("old", "malformed", ""),
      skill("a", { namespace: "acme" }),
    ]);
    assert.deepEqual(summary(groups), [["acme", null, ["a"]], [null, null, ["notes", "old"]]]);
    assert.deepEqual(summary(searchSkillGroups(groups, "未分组", "未分组")), [[null, null, ["notes", "old"]]]);
  });
});
