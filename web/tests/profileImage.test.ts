import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { identityMonogram } from "../src/lib/identity.js";

describe("Profile images", () => {
  it("supports agent and team image upload, removal, and fallback marks", async () => {
    const apiSource = await readFile(resolve("web/src/api.ts"), "utf8");
    const pickerSource = await readFile(resolve("web/src/components/ProfileImagePicker.tsx"), "utf8");
    const agentProfileSource = await readFile(resolve("web/src/components/AgentProfilePanel.tsx"), "utf8");
    const teamProfileSource = await readFile(resolve("web/src/components/TeamWorkspacePage.tsx"), "utf8");

    assert.match(apiSource, /updateAgentProfileImage/);
    assert.match(apiSource, /deleteAgentProfileImage/);
    assert.match(apiSource, /updateTeamProfileImage/);
    assert.match(apiSource, /deleteTeamProfileImage/);
    assert.match(pickerSource, /image\/png,image\/jpeg,image\/webp/);
    assert.match(pickerSource, /MAX_PROFILE_IMAGE_BYTES/);
    // The default profile image is a class mark, not a name: every agent
    // without an image wears the agent mark and every team wears the team
    // mark, so the two are separable by silhouette alone. The vendor glyphs
    // survive only where an executor kind, not a logical identity, is named.
    assert.match(agentProfileSource, /<ProfileImagePicker/);
    assert.match(agentProfileSource, /fallback=\{<IdentityMark kind="agent" \/>\}/);
    assert.match(teamProfileSource, /<ProfileImagePicker/);
    assert.match(teamProfileSource, /fallback=\{<IdentityMark kind="team" \/>\}/);
  });

  it("derives a stable monogram from the display name", () => {
    // Multi-word names abbreviate to initials; a single word takes its first
    // two characters so `claude` and `codex` stay distinguishable.
    assert.equal(identityMonogram("Growth Team"), "GT");
    assert.equal(identityMonogram("growth.lead"), "GL");
    assert.equal(identityMonogram("claude-main"), "CM");
    assert.equal(identityMonogram("claude"), "CL");
    assert.equal(identityMonogram("研究组"), "研究");
    assert.equal(identityMonogram("   "), "?");

  });

  it("gives every chat-panel agent surface the same profile image", async () => {
    const messageBlock = await readFile(resolve("web/src/components/MessageBlock.tsx"), "utf8");
    const agentSelect = await readFile(resolve("web/src/components/composer/AgentSelect.tsx"), "utf8");
    const transcriptEmpty = await readFile(resolve("web/src/components/TranscriptEmpty.tsx"), "utf8");
    const chatCss = await readFile(resolve("web/src/styles/chat.css"), "utf8");

    // A turn's face is resolved by the logical agent id that ran it — keyed
    // exactly like its label — so two agents sharing an executor kind never
    // wear each other's image.
    assert.match(messageBlock, /imageForAgentRun\(message, logicalAgentImages\)/);
    assert.match(messageBlock, /fallback=\{<IdentityMark kind="agent" \/>\}/);
    assert.doesNotMatch(messageBlock, /rail-node-agent[\s\S]{0,120}<AgentMark/);

    // The composer picker names one logical agent, so it reads profileImageUrl
    // straight off it. The new-thread landing speaks for Relay itself, not
    // whichever agent the picker happens to point at — the product mark, no
    // agent face, no executor tint.
    assert.match(agentSelect, /RosterTriggerValue agent=\{activeLogicalAgent\}/);
    assert.match(agentSelect, /RosterOption agent=\{logicalAgent\}/);
    const roster = await readFile(resolve("web/src/components/roster/RosterOption.tsx"), "utf8");
    assert.match(roster, /imageUrl=\{agent\.profileImageUrl\}/);
    assert.doesNotMatch(agentSelect, /AgentMark/);
    assert.match(transcriptEmpty, /RelayMark/);
    assert.doesNotMatch(transcriptEmpty, /ProfileImage|AgentMark|agent-avatar/);

    // The image must fill the 20px speaker node, and a grouped continuation
    // has to dim it the same way it dimmed the old glyph.
    assert.match(chatCss, /\.rail-node-agent > \.profile-image \{[^}]*width: 100%/);
    assert.match(chatCss, /\.msg-agent\.grouped \.rail-node-agent > \.profile-image/);
  });

  it("separates the agent and team default marks by silhouette, not colour", async () => {
    const markSource = await readFile(resolve("web/src/components/IdentityMark.tsx"), "utf8");

    // One primitive, two compositions: a lone node is an agent; a cluster of
    // three of the same node is a team.
    assert.match(markSource, /kind: "agent" \| "team"/);
    assert.match(markSource, /AGENT_PATHS/);
    assert.match(markSource, /TEAM_PATHS/);
    // Neutral by construction: the mark inherits ink and never names a hue.
    assert.match(markSource, /currentColor/);
    assert.doesNotMatch(markSource, /identityHue|--avatar-hue|hsl\(/);
  });

  it("leaves no procedural identity hue anywhere in the palette", async () => {
    const identitySource = await readFile(resolve("web/src/lib/identity.ts"), "utf8");
    const profileCss = await readFile(resolve("web/src/styles/profile-image.css"), "utf8");
    const backlogCss = await readFile(resolve("web/src/styles/backlog.css"), "utf8");
    const paletteCss = await readFile(resolve("web/src/styles/tokens/palette.css"), "utf8");

    // palette.css is the only colour source: with identity marks neutral,
    // the two hand-rolled hsl() exemptions have nothing left to exempt.
    assert.doesNotMatch(identitySource, /identityHue/);
    for (const css of [profileCss, backlogCss]) {
      assert.doesNotMatch(css, /--avatar-hue/);
      assert.doesNotMatch(css, /stylelint-disable-next-line function-disallowed-list/);
    }
    assert.doesNotMatch(paletteCss, /--avatar-sat|--avatar-light/);

    const rule = profileCss.match(/\.identity-mark\s*\{([^}]*)\}/)?.[1] ?? "";
    assert.match(rule, /color:\s*var\(--ink-2\)/);
    assert.match(rule, /background:\s*var\(--surface-2\)/);
  });
});
