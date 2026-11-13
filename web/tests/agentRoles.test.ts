import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { AGENT_ROLE_OPTIONS } from "../src/domain-types/agents.js";
import { PROJECT_ROLE_OPTIONS } from "../src/domain-types/projects.js";

const LOCALES = ["en", "zh-CN", "zh-TW"];

interface Strings {
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
  it("offers an Agent, a Team and a Project the same roles", () => {
    assert.deepEqual([...PROJECT_ROLE_OPTIONS].sort(), [...AGENT_ROLE_OPTIONS].sort());
  });

  it("covers work beyond the five software-team roles", () => {
    for (const role of ["researcher", "designer", "writer", "devops"] as const) {
      assert.ok(AGENT_ROLE_OPTIONS.includes(role), role);
    }
  });

  it("names every role wherever people choose one", () => {
    for (const locale of LOCALES) {
      const copy = strings(locale);
      for (const role of AGENT_ROLE_OPTIONS) {
        assert.equal(typeof copy.project.roles[role], "string", `${locale} project.roles.${role}`);
        assert.equal(typeof copy.team_work[`role_${role}`], "string", `${locale} team_work.role_${role}`);
        assert.equal(typeof copy.admin.v2.agent_role[role], "string", `${locale} admin.v2.agent_role.${role}`);
      }
    }
  });
});
