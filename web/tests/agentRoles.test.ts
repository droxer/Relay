import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { AGENT_ROLE_LEVEL_OPTIONS, AGENT_ROLE_OPTIONS } from "../src/domain-types/agents.js";
import { PROJECT_ROLE_LEVEL_OPTIONS, PROJECT_ROLE_OPTIONS } from "../src/domain-types/projects.js";
import { previewSlots, turnSlot } from "../src/lib/collaborationStyle.js";

const LOCALES = ["en", "zh-CN", "zh-TW"];

interface Strings {
  collab_style: Record<string, string>;
  role_hints: Record<string, string>;
  role_levels: Record<string, string>;
  role_level_hints: Record<string, string>;
  admin: { v2: { agent_role: Record<string, string> } };
  project: { roles: Record<string, string> };
  team_work: Record<string, string>;
}

function strings(locale: string): Strings {
  return JSON.parse(
    readFileSync(resolve(`web/src/i18n/locales/${locale}/translation.json`), "utf8"),
  ) as Strings;
}

describe("agent role vocabulary", () => {
  it("offers an Agent, a Team and a Project the same roles and levels in the same order", () => {
    assert.deepEqual(PROJECT_ROLE_OPTIONS, AGENT_ROLE_OPTIONS);
    assert.deepEqual(PROJECT_ROLE_LEVEL_OPTIONS, AGENT_ROLE_LEVEL_OPTIONS);
    assert.deepEqual(AGENT_ROLE_LEVEL_OPTIONS, ["junior", "senior"]);
  });

  it("offers development, design, testing, DevOps and operations as Project roles", () => {
    const labels = strings("zh-CN").project.roles;
    assert.deepEqual(
      ["implementer", "designer", "tester", "devops", "operations"].map((role) =>
        PROJECT_ROLE_OPTIONS.some((option) => option === role) ? labels[role] : undefined,
      ),
      ["开发", "设计", "测试", "运维", "运营"],
    );
  });

  it("gives Operations a Pipeline turn and keeps it out of the reviewer slot", () => {
    const members = [{ id: "ops", role: "operations" }, { id: "dev", role: "implementer" }];
    assert.deepEqual(previewSlots(members, undefined, "pipeline").slots.map(({ memberId }) => memberId), ["dev", "ops"]);
    assert.deepEqual(previewSlots(members, undefined, "build_review").slots, [{ slot: "builder", memberId: "dev" }]);
    assert.equal(turnSlot({ role: "operations" }, "pipeline"), "operations");
  });

  it("offers roles in the order a Pipeline round takes them", () => {
    const order = previewSlots(
      AGENT_ROLE_OPTIONS.map((role) => ({ id: role, role })),
      undefined,
      "pipeline",
    ).slots.map((slot) => slot.memberId);
    assert.deepEqual(order, [...AGENT_ROLE_OPTIONS]);
  });

  it("covers work beyond the five software-team roles including security and performance", () => {
    for (const role of ["researcher", "product_manager", "data", "designer", "security", "performance", "writer", "devops"] as const) {
      assert.ok(AGENT_ROLE_OPTIONS.includes(role), role);
    }
  });

  it("names every role and level wherever people choose one", () => {
    for (const locale of LOCALES) {
      const copy = strings(locale);
      for (const role of AGENT_ROLE_OPTIONS) {
        assert.equal(typeof copy.project.roles[role], "string", `${locale} project.roles.${role}`);
        assert.equal(typeof copy.team_work[`role_${role}`], "string", `${locale} team_work.role_${role}`);
        assert.equal(typeof copy.admin.v2.agent_role[role], "string", `${locale} admin.v2.agent_role.${role}`);
        assert.equal(typeof copy.role_hints[role], "string", `${locale} role_hints.${role}`);
      }
      for (const key of [
        "label",
        "standard",
        ...AGENT_ROLE_LEVEL_OPTIONS,
        ...AGENT_ROLE_LEVEL_OPTIONS.map((level) => `badge_${level}`),
      ]) {
        assert.equal(typeof copy.role_levels[key], "string", `${locale} role_levels.${key}`);
      }
      for (const key of ["standard", ...AGENT_ROLE_LEVEL_OPTIONS]) {
        assert.equal(typeof copy.role_level_hints[key], "string", `${locale} role_level_hints.${key}`);
      }
      for (const turn of ["turn_product_manager", "turn_data", "turn_security", "turn_performance", "turn_operations"]) {
        assert.equal(typeof copy.collab_style[turn], "string", `${locale} collab_style.${turn}`);
      }
    }
  });
});
