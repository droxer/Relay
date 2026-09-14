import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGENT_NAMES,
  AGENT_REGISTRY,
  DAEMON_CAPABILITY_AGENT_SKILLS,
  buildClaudeCommand,
  buildCodexCommand,
  buildKimiCommand,
  buildPiCommand,
  type AgentState,
  type DaemonNodeRunCommand,
  type DaemonRunSkillBundle,
} from "../src/index.js";

function state(overrides: Partial<AgentState> = {}): AgentState {
  return {
    task_goal: "Use the granted skills",
    agent_logs: [],
    last_exit_code: 0,
    agent_failures: {},
    ...overrides,
  };
}

function asCurrentUser<T>(build: () => T): T {
  const previous = process.env.RELAY_RUN_AS_CURRENT_USER;
  process.env.RELAY_RUN_AS_CURRENT_USER = "1";
  try {
    return build();
  } finally {
    if (previous === undefined) delete process.env.RELAY_RUN_AS_CURRENT_USER;
    else process.env.RELAY_RUN_AS_CURRENT_USER = previous;
  }
}

describe("skill delivery", () => {
  it("declares the verified delivery mechanism for every agent", () => {
    for (const name of AGENT_NAMES) {
      assert.ok(AGENT_REGISTRY[name].skillDelivery, `${name} has no skillDelivery`);
    }
    assert.deepEqual(AGENT_REGISTRY.claude.skillDelivery, {
      kind: "config-dir",
      envVar: "CLAUDE_CONFIG_DIR",
      subdir: ".claude",
      skillsSubpath: "skills",
    });
    assert.deepEqual(AGENT_REGISTRY.pi.skillDelivery, {
      kind: "skill-path-flag",
      flag: "--skill",
      disableDiscoveryFlag: "--no-skills",
    });
    assert.deepEqual(AGENT_REGISTRY.codex.skillDelivery, {
      kind: "config-dir",
      envVar: "CODEX_HOME",
      subdir: ".codex",
      skillsSubpath: "skills",
    });
    assert.deepEqual(AGENT_REGISTRY.kimi.skillDelivery, {
      kind: "skills-dir-flag",
      flag: "--skills-dir",
    });
  });

  it("isolates Pi discovery and shell-quotes every explicit skill path", () => {
    const command = asCurrentUser(() =>
      buildPiCommand(state({ skill_paths: ["/store/a", "/store/it's-b"] })),
    );
    assert.match(command, /--no-skills/);
    assert.match(command, /--skill \/store\/a/);
    assert.ok(command.includes("--skill '/store/it'\\''s-b'"));
  });

  it("distinguishes unmanaged Pi discovery from an explicitly empty managed set", () => {
    assert.doesNotMatch(buildPiCommand(state()), /--no-skills/);
    const managedEmpty = buildPiCommand(state({ skill_paths: [] }));
    assert.match(managedEmpty, /--no-skills/);
    assert.doesNotMatch(managedEmpty, /--skill /);
  });

  it("repeats Kimi's directory-container flag and quotes each path", () => {
    const command = asCurrentUser(() =>
      buildKimiCommand(state({ skill_paths: ["/views/a", "/views/b c"] })),
    );
    assert.match(command, /--skills-dir \/views\/a/);
    assert.match(command, /--skills-dir '\/views\/b c'/);
  });

  it("injects only the delivery environment variable inside the agent shell", () => {
    const skill_env = {
      CLAUDE_CONFIG_DIR: "/runs/claude's-config",
      CODEX_HOME: "/runs/codex-home",
      UNDECLARED_SECRET: "must-not-leak",
    };
    const claude = asCurrentUser(() => buildClaudeCommand(state({ skill_env })));
    const codex = asCurrentUser(() => buildCodexCommand(state({ skill_env })));
    assert.ok(claude.includes("export CLAUDE_CONFIG_DIR='/runs/claude'\\''s-config'"));
    assert.doesNotMatch(claude, /CODEX_HOME='\/runs\/codex-home'/);
    assert.doesNotMatch(claude, /UNDECLARED_SECRET/);
    assert.match(codex, /export CODEX_HOME=\/runs\/codex-home/);
    assert.doesNotMatch(codex, /CLAUDE_CONFIG_DIR='\/runs\/claude/);
    assert.doesNotMatch(codex, /UNDECLARED_SECRET/);
  });

  it("exports the versioned daemon skill bundle and skipped-skill contracts", () => {
    const bundle: DaemonRunSkillBundle = {
      contract: { name: "relay.agent.skills", version: 1 },
      skills: [{
        skillId: "skill-1",
        revisionId: "revision-2",
        slug: "review/code-review",
        manifestSha256: "manifest-sha",
        files: [{ path: "SKILL.md", sha256: "file-sha", bytes: 42 }],
      }],
    };
    const command: DaemonNodeRunCommand = {
      id: "command-1",
      type: "run.start",
      sessionId: "session-1",
      runId: "run-1",
      taskGoal: "Review",
      agent: "codex",
      skills: bundle,
      skillsSkipped: [{ skillId: "skill-2", slug: "missing", reason: "deleted" }],
    };
    assert.equal(DAEMON_CAPABILITY_AGENT_SKILLS, "agent-skills");
    assert.equal(command.skills?.skills[0]?.files[0]?.bytes, 42);
    assert.equal(command.skillsSkipped?.[0]?.reason, "deleted");
  });
});
