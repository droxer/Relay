import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("agent skills on the agent record", () => {
  it("ships the skills copy in every locale", async () => {
    for (const locale of ["en", "zh-CN", "zh-TW"]) {
      const raw = await readFile(resolve(`web/src/i18n/locales/${locale}/translation.json`), "utf8");
      const json = JSON.parse(raw);
      assert.equal(typeof json.agents_page.tab_skills, "string", `${locale} missing agents_page.tab_skills`);
      assert.equal(typeof json.agents_page.skills_empty, "string", `${locale} missing agents_page.skills_empty`);
    }
  });

  it("carries node-reported skills on the agent record type", async () => {
    const types = await readFile(resolve("web/src/types.ts"), "utf8");
    assert.match(types, /skills\?: DaemonAgentSkill\[\];/);
  });

  it("gives skills their own tab on the agent record, not a profile section", async () => {
    const detailSource = await readFile(resolve("web/src/components/AgentDetailPage.tsx"), "utf8");
    assert.match(detailSource, /DETAIL_TABS: readonly AgentDetailTab\[\] = \["profile", "skills", "activities"\]/);
    assert.match(detailSource, /<AgentSkillsPanel/);
    const profileSource = await readFile(resolve("web/src/components/AgentProfilePanel.tsx"), "utf8");
    assert.doesNotMatch(profileSource, /agent-skill-list/, "profile tab must not restate the skills list");
  });

  it("prints the skills list for every viewer of the record, not only editors", async () => {
    const panelSource = await readFile(resolve("web/src/components/AgentSkillsPanel.tsx"), "utf8");
    assert.match(panelSource, /agents_page\.skills_empty/);
    assert.match(panelSource, /agent-skill-list/);
    // Only the revoke control is gated — the inventory itself always renders.
    assert.ok(
      panelSource.indexOf("agent-skill-list") < panelSource.indexOf("canEdit &&"),
      "skills list must render outside the edit gate",
    );
  });

  it("opens a granted skill's bundle for reading from the agent record", async () => {
    const panelSource = await readFile(resolve("web/src/components/AgentSkillsPanel.tsx"), "utf8");
    assert.match(panelSource, /<SkillPreviewDrawer/);
    // Only a catalog grant has a bundle to read; a node-installed skill has no
    // catalog record, so its name must stay plain text.
    assert.match(panelSource, /skill\.skillId \? \(\s*<button/);

    const drawer = await readFile(resolve("web/src/components/SkillPreviewDrawer.tsx"), "utf8");
    assert.match(drawer, /readSkillFile\(skillId, path, channel, signal\)/);
    // The preview must read the bundle the agent actually gets.
    assert.match(panelSource, /skill\.pin === "latest" \? "latest" : "stable"/);

    const api = await readFile(resolve("web/src/api.ts"), "utf8");
    assert.match(api, /\/skills\/\$\{encodeURIComponent\(skillId\)\}\/files\?path=/);

    for (const locale of ["en", "zh-CN", "zh-TW"]) {
      const json = JSON.parse(await readFile(resolve(`web/src/i18n/locales/${locale}/translation.json`), "utf8"));
      for (const key of ["preview_kicker", "preview_loading", "preview_truncated", "preview_revision"]) {
        assert.equal(typeof json.skills[key], "string", `${locale} missing skills.${key}`);
      }
      assert.equal(typeof json.skills.channel.stable, "string", `${locale} missing skills.channel.stable`);
    }
  });

  it("styles the skill list from palette tokens only", async () => {
    const css = await readFile(resolve("web/src/styles/workspace-dossier.css"), "utf8");
    const block = css.slice(css.indexOf(".agent-skill-list"));
    assert.match(block, /\.agent-skill-name \{/);
    assert.match(block, /\.agent-skill-description \{/);
    assert.doesNotMatch(block.split(".agent-skill-description")[1] ?? "", /#[0-9a-fA-F]{3,8}/);
  });
});
