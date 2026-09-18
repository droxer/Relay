import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentRun, RelayArtifact } from "relay-core";
import { labelForAgentRun } from "../src/lib/agentDisplayNames.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildSpaceItems,
  clampSpaceWidth,
  defaultSpaceTab,
  isThreadSpaceEmpty,
  maxSpaceWidth,
  SPACE_VIEWPORT_SHARE,
  resolveSelectedSpaceItem,
  resolveSpaceTab,
  SPACE_WIDTH_DEFAULT,
  SPACE_WIDTH_MAX,
  SPACE_WIDTH_MIN,
  threadHasMultipleProducers,
  TRANSCRIPT_MIN_WIDTH,
} from "../src/lib/threadSpace.js";

function artifact(input: Partial<RelayArtifact> & Pick<RelayArtifact, "id" | "createdAt">): RelayArtifact {
  return {
    kind: "workspace_file",
    title: input.id,
    path: `/tmp/${input.id}`,
    ...input,
  };
}

function run(input: Partial<AgentRun> & Pick<AgentRun, "id" | "agent">): AgentRun {
  return {
    status: "completed",
    startedAt: "2026-08-08T10:00:00.000Z",
    artifactIds: [],
    ...input,
  };
}

describe("buildSpaceItems", () => {
  it("sorts newest first", () => {
    const items = buildSpaceItems(
      [
        artifact({ id: "art_old", createdAt: "2026-08-08T10:01:00.000Z" }),
        artifact({ id: "art_new", createdAt: "2026-08-08T10:03:00.000Z" }),
        artifact({ id: "art_mid", createdAt: "2026-08-08T10:02:00.000Z" }),
      ],
      [],
    );

    assert.deepEqual(items.map((item) => item.artifact.id), ["art_new", "art_mid", "art_old"]);
  });

  it("resolves the producing agent through the run's logical agent id", () => {
    const items = buildSpaceItems(
      [artifact({ id: "art_1", createdAt: "2026-08-08T10:01:00.000Z", agentRunId: "run_1" })],
      [run({ id: "run_1", agent: "claude", logicalAgentId: "agent_ops" })],
      { agent_ops: "Ops Writer" },
      { claude: "Claude Fallback" },
    );

    assert.equal(items[0]?.producerLabel, "Ops Writer");
  });

  it("falls back to the executor display name for legacy runs without a logical agent id", () => {
    const items = buildSpaceItems(
      [artifact({ id: "art_1", createdAt: "2026-08-08T10:01:00.000Z", agentRunId: "run_1" })],
      [run({ id: "run_1", agent: "claude" })],
      { agent_ops: "Ops Writer" },
      { claude: "Claude Fallback" },
    );

    assert.equal(items[0]?.producerLabel, "Claude Fallback");
  });

  it("falls back to the executor display name when the logical agent no longer exists", () => {
    const items = buildSpaceItems(
      [artifact({ id: "art_1", createdAt: "2026-08-08T10:01:00.000Z", agentRunId: "run_1" })],
      [run({ id: "run_1", agent: "codex", logicalAgentId: "agent_gone" })],
      {},
      { codex: "Codex Reviewer" },
    );

    assert.equal(items[0]?.producerLabel, "Codex Reviewer");
  });

  it("leaves the producer empty when the artifact has no run attribution", () => {
    const items = buildSpaceItems(
      [artifact({ id: "art_1", createdAt: "2026-08-08T10:01:00.000Z" })],
      [run({ id: "run_1", agent: "claude", logicalAgentId: "agent_ops" })],
      { agent_ops: "Ops Writer" },
    );

    assert.equal(items[0]?.producerLabel, null);
  });

  it("matches labelForAgentRun for every attribution path", () => {
    const logicalAgentNames = { agent_ops: "Ops Writer", agent_research: "Researcher" };
    const agentDisplayNames = { claude: "Claude Executor" } as const;
    const runs = [
      run({ id: "run_named", agent: "claude", logicalAgentId: "agent_ops" }),
      run({ id: "run_legacy", agent: "claude" }),
      run({ id: "run_missing", agent: "claude", logicalAgentId: "agent_deleted" }),
      run({ id: "run_unmapped", agent: "kimi" }),
    ];
    const artifacts = runs.map((r) =>
      artifact({ id: `art_${r.id}`, createdAt: "2026-08-08T10:01:00.000Z", agentRunId: r.id })
    );

    const items = buildSpaceItems(artifacts, runs, logicalAgentNames, agentDisplayNames);
    for (const item of items) {
      const source = runs.find((r) => `art_${r.id}` === item.artifact.id)!;
      assert.equal(
        item.producerLabel,
        labelForAgentRun(
          { agent: source.agent, ...(source.logicalAgentId ? { agentId: source.logicalAgentId } : {}) },
          logicalAgentNames,
          agentDisplayNames,
        ),
        `attribution drifted for ${source.id}`,
      );
    }
  });
});

describe("threadHasMultipleProducers", () => {
  it("is false for a single-agent thread", () => {
    const runs = [
      run({ id: "run_1", agent: "claude", logicalAgentId: "agent_ops" }),
      run({ id: "run_2", agent: "claude", logicalAgentId: "agent_ops" }),
    ];

    assert.equal(threadHasMultipleProducers(runs), false);
  });

  it("is true when two logical agents share an executor kind", () => {
    const runs = [
      run({ id: "run_1", agent: "claude", logicalAgentId: "agent_ops" }),
      run({ id: "run_2", agent: "claude", logicalAgentId: "agent_research" }),
    ];

    assert.equal(threadHasMultipleProducers(runs), true);
  });

  it("counts legacy runs by executor kind", () => {
    const runs = [run({ id: "run_1", agent: "claude" }), run({ id: "run_2", agent: "codex" })];

    assert.equal(threadHasMultipleProducers(runs), true);
    assert.equal(threadHasMultipleProducers([run({ id: "run_3", agent: "pi" })]), false);
    assert.equal(threadHasMultipleProducers(undefined), false);
  });
});

describe("resolveSelectedSpaceItem", () => {
  const items = buildSpaceItems(
    [artifact({ id: "art_1", createdAt: "2026-08-08T10:01:00.000Z" })],
    [],
  );

  it("returns the selected item", () => {
    assert.equal(resolveSelectedSpaceItem(items, "art_1")?.artifact.id, "art_1");
  });

  it("degrades to the list level for a stale or missing selection", () => {
    assert.equal(resolveSelectedSpaceItem(items, "art_replaced"), null);
    assert.equal(resolveSelectedSpaceItem(items, null), null);
  });
});

describe("isThreadSpaceEmpty", () => {
  it("reflects whether the thread produced anything", () => {
    assert.equal(isThreadSpaceEmpty([]), true);
    assert.equal(
      isThreadSpaceEmpty(buildSpaceItems([artifact({ id: "art_1", createdAt: "2026-08-08T10:01:00.000Z" })], [])),
      false,
    );
  });
});

describe("clampSpaceWidth", () => {
  it("keeps the dragged width inside the panel bounds", () => {
    assert.equal(clampSpaceWidth(SPACE_WIDTH_DEFAULT), SPACE_WIDTH_DEFAULT);
    assert.equal(clampSpaceWidth(10), SPACE_WIDTH_MIN);
    assert.equal(clampSpaceWidth(10_000), SPACE_WIDTH_MAX);
    assert.equal(clampSpaceWidth(Number.NaN), SPACE_WIDTH_DEFAULT);
  });

  it("honours a tighter ceiling from the available room", () => {
    assert.equal(clampSpaceWidth(700, 500), 500);
    assert.equal(clampSpaceWidth(400, 500), 400);
    // A ceiling below the minimum still yields a usable panel.
    assert.equal(clampSpaceWidth(700, 100), SPACE_WIDTH_MIN);
    // And it can never exceed the absolute maximum.
    assert.equal(clampSpaceWidth(10_000, 10_000), SPACE_WIDTH_MAX);
  });
});

describe("maxSpaceWidth", () => {
  it("lets the panel take only what the transcript can spare", () => {
    // 700px transcript, 420px floor → 280px of room on top of the current width.
    assert.equal(maxSpaceWidth(384, 700), 384 + (700 - TRANSCRIPT_MIN_WIDTH));
  });

  it("caps at the absolute maximum however wide the transcript is", () => {
    assert.equal(maxSpaceWidth(384, 4000), SPACE_WIDTH_MAX);
  });

  it("shrinks the ceiling below the current width once the floor is crossed", () => {
    // Transcript already under its floor: the ceiling drops below the current
    // width, which is what makes the window-resize clamp give room back.
    assert.ok(maxSpaceWidth(600, TRANSCRIPT_MIN_WIDTH - 100) < 600);
  });

  it("falls back to the absolute maximum with nothing to measure", () => {
    assert.equal(maxSpaceWidth(384, null), SPACE_WIDTH_MAX);
    assert.equal(maxSpaceWidth(384, Number.NaN), SPACE_WIDTH_MAX);
  });

  it("never lets a drag outrun the viewport cap the grid applies", () => {
    // Same contract as the sidenav and the thread list: the shell track asks
    // for min(--space-w, Nvw), so a drag past that cap would move a number the
    // rendered panel does not follow.
    const viewport = 1024;
    assert.equal(maxSpaceWidth(SPACE_WIDTH_DEFAULT, 4000, viewport), Math.round(SPACE_VIEWPORT_SHARE * viewport));
    assert.equal(maxSpaceWidth(SPACE_WIDTH_DEFAULT, 4000, 2560), SPACE_WIDTH_MAX);
    assert.equal(maxSpaceWidth(SPACE_WIDTH_DEFAULT, 4000, null), SPACE_WIDTH_MAX);
    assert.equal(maxSpaceWidth(SPACE_WIDTH_DEFAULT, 4000, 320), SPACE_WIDTH_MIN);
  });

  it("never reports a ceiling below the panel minimum", () => {
    assert.equal(maxSpaceWidth(SPACE_WIDTH_MIN, 0), SPACE_WIDTH_MIN);
  });
});

describe("space tabs", () => {
  it("opens a project thread on the shared workspace", () => {
    assert.equal(defaultSpaceTab("prj-1"), "project");
  });

  it("opens a thread with no project on its own files", () => {
    assert.equal(defaultSpaceTab(null), "thread");
    assert.equal(defaultSpaceTab(undefined), "thread");
    assert.equal(defaultSpaceTab(""), "thread");
  });

  it("never shows the project tab for a thread with no project", () => {
    assert.equal(resolveSpaceTab("project", null, false), "thread");
  });

  it("follows a selected file back to this thread", () => {
    // The transcript can select one while the panel sits on Project.
    assert.equal(resolveSpaceTab("project", "prj-1", true), "thread");
  });

  it("otherwise keeps the tab the user picked", () => {
    assert.equal(resolveSpaceTab("thread", "prj-1", false), "thread");
    assert.equal(resolveSpaceTab("project", "prj-1", false), "project");
  });
});

describe("thread space panel wiring", () => {
  const readWeb = (path: string) => readFileSync(resolve("web", path), "utf8");

  it("hands the panel the thread's project so its files are browsable", () => {
    assert.match(
      readWeb("src/components/ThreadsView.tsx"),
      /projectId=\{activeSession\.projectId \?\? null\}/,
    );
    /* Keyed by project, not merely handed the id: the browser holds its
       directory path in local state, so an unkeyed element survives a project
       change and re-requests the previous project's path against a workspace
       that has no such directory. The open FILE is lifted to the panel (the
       header stands down while one is open) and reset alongside the tab. */
    const panel = readWeb("src/components/space/ThreadSpacePanel.tsx");
    assert.match(panel, /<ThreadSpaceFiles\s+key=\{projectId\}\s+projectId=\{projectId\}/);
    assert.match(panel, /useEffect\(\(\) => setProjectFile\(""\), \[projectId, sessionId\]\)/);
  });

  it("gives the empty state an action, not just a sentence", () => {
    const panel = readWeb("src/components/space/ThreadSpacePanel.tsx");
    assert.match(panel, /space\.empty_cta_files/);
    assert.match(panel, /space\.empty_cta_back/);
  });

  it("names the panel toggle instead of leaving a bare glyph", () => {
    assert.match(
      readWeb("src/components/ArtifactNavButton.tsx"),
      /className="chat-artifacts-label"/,
    );
  });

  it("names the toggle for where it lands, and drops the count it would not open on", () => {
    const button = readWeb("src/components/ArtifactNavButton.tsx");
    assert.match(button, /inProject \? t\("space\.title_project"\) : t\("space\.title"\)/);
    assert.match(button, /const showCount = !inProject && artifactCount > 0;/);
  });

  it("keeps the word \"output\" out of the panel's vocabulary", () => {
    const en = JSON.parse(readWeb("src/i18n/locales/en/translation.json")) as {
      space: Record<string, string>;
    };
    for (const [key, value] of Object.entries(en.space)) {
      assert.ok(!/output/i.test(value), `space.${key} still says "output": ${value}`);
    }
  });
});
