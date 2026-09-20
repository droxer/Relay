import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  canonicalBrowserUrl,
  parseAppPath,
  pathForAppState,
} from "../src/lib/appRoute.js";
import {
  defaultRecordTab,
  parseRecordTab,
  recordTabs,
  recordVariant,
} from "../src/components/task-record/recordVocabulary.js";
import { recordActions } from "../src/components/task-record/recordActions.js";

const readWeb = (path: string) => readFileSync(resolve("web", path), "utf8");

const base = { mobileView: "chat" as const, sessionId: null };

describe("task record routes", () => {
  it("addresses a backlog task, a routine, and one of its runs", () => {
    assert.deepEqual(parseAppPath("/backlog/T-1001"), {
      route: "backlog",
      ...base,
      taskId: "T-1001",
    });
    assert.deepEqual(parseAppPath("/routines/R-42"), {
      route: "routine",
      ...base,
      taskId: "R-42",
    });
    assert.deepEqual(parseAppPath("/routines/R-42/runs/T-2288"), {
      route: "routine",
      ...base,
      taskId: "R-42",
      runId: "T-2288",
    });
  });

  it("round-trips every record path through pathForAppState", () => {
    for (const path of ["/backlog/T-1001", "/routines/R-42", "/routines/R-42/runs/T-2288"]) {
      assert.equal(pathForAppState(parseAppPath(path)), path, path);
    }
  });

  it("keeps the bare list paths working", () => {
    assert.equal(parseAppPath("/backlog").route, "backlog");
    assert.equal(parseAppPath("/backlog").taskId, undefined);
    assert.equal(parseAppPath("/routines").route, "routine");
  });

  it("encodes an id that is not URL-safe", () => {
    const path = pathForAppState({ route: "routine", ...base, taskId: "a/b" });
    assert.equal(path, "/routines/a%2Fb");
    assert.equal(parseAppPath(path).taskId, "a/b");
  });

  /* A tab id the canonicalizer does not own is stripped on arrival, which
     makes the control toggle and land back where it started — a dead control
     that renders correctly. Every tab the record offers must survive here. */
  it("carries every record tab through canonicalization", () => {
    for (const tab of ["definition", "files"]) {
      assert.equal(
        canonicalBrowserUrl("/backlog/T-1001", `?tab=${tab}`),
        `/backlog/T-1001?tab=${tab}`,
        `the task record drops ?tab=${tab}`,
      );
    }
    for (const tab of ["definition", "files"]) {
      assert.equal(
        canonicalBrowserUrl("/routines/R-42", `?tab=${tab}`),
        `/routines/R-42?tab=${tab}`,
        `the routine record drops ?tab=${tab}`,
      );
    }
    // A run speaks the task vocabulary even though it is addressed under its routine.
    assert.equal(
      canonicalBrowserUrl("/routines/R-42/runs/T-2288", "?tab=files"),
      "/routines/R-42/runs/T-2288?tab=files",
    );
  });

  it("does not advertise a tab the reader did not choose, or one that does not exist", () => {
    // The default tab carries no param.
    assert.equal(canonicalBrowserUrl("/routines/R-42", "?tab=runs"), "/routines/R-42");
    assert.equal(canonicalBrowserUrl("/backlog/T-1001", "?tab=activity"), "/backlog/T-1001");
    // A routine has no Activity tab and a task has no Runs tab.
    assert.equal(canonicalBrowserUrl("/routines/R-42", "?tab=activity"), "/routines/R-42");
    assert.equal(canonicalBrowserUrl("/backlog/T-1001", "?tab=runs"), "/backlog/T-1001");
    assert.equal(canonicalBrowserUrl("/backlog/T-1001", "?tab=nonsense"), "/backlog/T-1001");
  });

  it("keeps the board's own params on the record the drawer opens over", () => {
    // The routines record is a drawer over the board — the list beneath keeps
    // its filters, so the record route co-owns them.
    assert.equal(
      canonicalBrowserUrl("/routines/R-42", "?state=paused&q=digest"),
      "/routines/R-42?q=digest&state=paused",
    );
    assert.equal(
      canonicalBrowserUrl("/routines/R-42/runs/T-2288", "?sort=title&page=2"),
      "/routines/R-42/runs/T-2288?sort=title&page=2",
    );
    // Params the board does not own are still stripped, and the backlog
    // record — still a full-page surface — starts clean.
    assert.equal(canonicalBrowserUrl("/routines/R-42", "?status=blocked"), "/routines/R-42");
    assert.equal(canonicalBrowserUrl("/backlog/T-1001", "?status=blocked"), "/backlog/T-1001");
  });
});

describe("record vocabulary", () => {
  it("gives a routine runs and a task activity", () => {
    assert.equal(recordVariant({ isRoutine: true }), "routine");
    assert.equal(recordVariant({ isRoutine: false }), "task");
    assert.deepEqual(recordTabs("routine"), ["runs", "definition", "files"]);
    assert.deepEqual(recordTabs("task"), ["activity", "definition", "files"]);
    assert.equal(defaultRecordTab("routine"), "runs");
    assert.equal(defaultRecordTab("task"), "activity");
  });

  it("falls back to the variant's own default rather than the other one's tab", () => {
    assert.equal(parseRecordTab("runs", "task"), "activity");
    assert.equal(parseRecordTab("activity", "routine"), "runs");
    assert.equal(parseRecordTab(null, "routine"), "runs");
    assert.equal(parseRecordTab("files", "task"), "files");
  });

  /* The tab set and the canonicalizer's table are two spellings of one fact.
     They drift silently — the tab renders, the URL never keeps it. */
  it("declares the same tabs the canonicalizer keeps", () => {
    const source = readWeb("src/lib/appRoute.ts");
    for (const tab of [...recordTabs("routine"), ...recordTabs("task")]) {
      assert.match(source, new RegExp(`"${tab}"`), `appRoute.ts does not register the ${tab} tab`);
    }
  });
});

describe("record actions", () => {
  const assigned = { assignedAgentId: "agent-1", assignedTeamId: "", routineEnabled: true };

  it("offers a running record a cancel and nothing else", () => {
    assert.deepEqual(recordActions({ ...assigned, isRoutine: false, status: "running" }), ["cancel"]);
    assert.deepEqual(recordActions({ ...assigned, isRoutine: true, status: "running" }), ["cancel"]);
  });

  it("offers a refused dispatch a retry", () => {
    assert.deepEqual(recordActions({ ...assigned, isRoutine: false, status: "blocked" }), ["retry"]);
    assert.deepEqual(recordActions({ ...assigned, isRoutine: false, status: "assigned" }), ["retry"]);
  });

  it("never offers retry and cancel at once", () => {
    const statuses = ["backlog", "assigned", "running", "waiting_for_human", "review", "blocked", "done"] as const;
    for (const status of statuses) {
      for (const isRoutine of [true, false]) {
        const actions = recordActions({ ...assigned, isRoutine, status });
        assert.ok(
          !(actions.includes("retry") && actions.includes("cancel")),
          `${status} (${isRoutine ? "routine" : "task"}) offers both retry and cancel`,
        );
      }
    }
  });

  it("will not dispatch a record that has nobody to dispatch to", () => {
    const unassigned = { assignedAgentId: "", assignedTeamId: "", routineEnabled: true };
    assert.deepEqual(recordActions({ ...unassigned, isRoutine: true, status: "backlog" }), []);
    assert.deepEqual(recordActions({ ...unassigned, isRoutine: false, status: "blocked" }), []);
    // A paused routine is not run by a button either.
    assert.deepEqual(
      recordActions({ ...assigned, routineEnabled: false, isRoutine: true, status: "backlog" }),
      [],
    );
  });
});

describe("the record surface owns what the drawer used to", () => {
  it("leaves the drawer a form", () => {
    const drawer = readWeb("src/components/task-board/TaskDrawer.tsx");
    for (const gone of [
      "RecordArtifacts",
      "RecordWorkspace",
      "RecordHistory",
      "RecordRuns",
      "RecordResultLine",
      "TaskDrawerArtifacts",
      "RoutineRunLedger",
      "onOpenThread",
      "meta",
    ]) {
      assert.doesNotMatch(drawer, new RegExp(`\\b${gone}\\b`), `TaskDrawer still carries ${gone}`);
    }
  });

  it("gives the run ledger one destination per row and no accordion", () => {
    const runs = readWeb("src/components/task-record/RecordRuns.tsx");
    assert.match(runs, /<a\s+className="record-run-link"/);
    // The expand control and its per-row event fetch belong to the run's own
    // surface now; a row that both expands and navigates has two answers to
    // one click.
    assert.doesNotMatch(runs, /aria-expanded/);
    assert.doesNotMatch(runs, /listTaskEvents/);
  });

  it("does not restate a band fact inside a tab", () => {
    // The band names the status; the result line states the run's facts only.
    const result = readWeb("src/components/task-record/RecordResultLine.tsx");
    assert.doesNotMatch(result, /task-result-outcome/);
    // The band names cadence, next run and assignee; the definition tab must not.
    const definition = readWeb("src/components/task-record/TaskRecordDefinition.tsx");
    for (const banded of ["routine.cadence", "routine.next_run", "backlog.assignee"]) {
      assert.doesNotMatch(definition, new RegExp(banded.replace(".", "\\.")), `definition restates ${banded}`);
    }
  });
});
