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
    for (const path of ["/issues/T-1001", "/routines/R-42", "/routines/R-42/runs/T-2288"]) {
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
    // Unknown params are stripped; task records preserve their list filters.
    assert.equal(canonicalBrowserUrl("/routines/R-42", "?status=blocked"), "/routines/R-42");
    assert.equal(canonicalBrowserUrl("/backlog/T-1001", "?status=blocked"), "/backlog/T-1001?status=blocked");
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

describe("record data access", () => {
  const panels = [
    "RecordRuns.tsx",
    "RecordHistory.tsx",
    "RecordArtifacts.tsx",
    "RecordResultLine.tsx",
  ];

  it("reads every panel through the query cache", () => {
    /* Four of the record's six panels hand-rolled useEffect + AbortController
       + local state while the other two used React Query. Tab panels unmount
       on switch and the strip activates on arrow keys, so the uncached half
       refired its whole request set per keystroke. */
    for (const panel of panels) {
      const source = readWeb(`src/components/task-record/${panel}`);
      assert.match(source, /useQuery/, `${panel} must read through the query cache`);
      assert.doesNotMatch(source, /new AbortController\(\)/, `${panel} must not hand-roll its fetch`);
      assert.match(source, /staleTime/, `${panel} needs a staleness horizon or tab surfing refires it`);
    }
  });

  it("offers a way out of a failed panel", () => {
    // Two panels used to render a dead-end alert and one stayed silent, while
    // the Files tab beside them offered Retry.
    for (const panel of ["RecordRuns.tsx", "RecordHistory.tsx", "RecordArtifacts.tsx"]) {
      const source = readWeb(`src/components/task-record/${panel}`);
      assert.match(source, /RecordFailure/, `${panel} must offer a retry`);
      assert.match(source, /refetch\(\)/, `${panel}'s retry must actually refetch`);
    }
  });

  it("refines a list in place instead of restarting it", () => {
    // "Show earlier" and the versions toggle both used to blank the list.
    for (const panel of ["RecordRuns.tsx", "RecordArtifacts.tsx"]) {
      assert.match(readWeb(`src/components/task-record/${panel}`), /keepPreviousData/, panel);
    }
  });
});

describe("record surface hygiene", () => {
  it("wears its own classes, not the retired drawer's", () => {
    /* The record replaced a drawer and kept wearing its classes, so the
       sheet named for the retired surface styled the live one and any
       change to the form drawer silently restyled the record. The form
       drawer's own three classes are the only ones left. */
    const DRAWER_OWN = new Set(["task-drawer-form-grid", "task-drawer-next-run", "task-drawer-title-error"]);
    for (const panel of [
      "RecordRuns.tsx", "RecordHistory.tsx", "RecordArtifacts.tsx",
      "RecordResultLine.tsx", "RecordWorkspace.tsx", "TaskRecordPage.tsx",
    ]) {
      const borrowed = (readWeb(`src/components/task-record/${panel}`).match(/task-drawer-[a-z-]+/g) ?? [])
        .filter((name) => !DRAWER_OWN.has(name));
      assert.deepEqual(borrowed, [], `${panel} borrows the drawer's classes`);
    }
  });

  it("mirrors a closing record drawer through one seam", () => {
    // Drawer presentations retain their record during the exit animation.
    for (const board of ["BacklogPage.tsx", "RoutinesPage.tsx"]) {
      const source = readWeb(`src/components/${board}`);
      assert.match(source, /useRecordDrawerMirror/, `${board} must mirror through the shared hook`);
      assert.doesNotMatch(source, /setLastRecord/, `${board} must not keep its own mirror`);
    }
  });
});

describe("record actions", () => {
  const assigned = { assignedAgentId: "agent-1", assignedTeamId: "", routineEnabled: true, projectId: "project-1" };

  it("offers an intake issue triage instead of a run", () => {
    /* An issue outside a project cannot run — the server refuses it — so a
       legacy one that still carries an agent offers the way into a project,
       never Retry. A routine run is exempt: its routine names the crew. */
    const intake = { ...assigned, projectId: undefined };
    assert.deepEqual(recordActions({ ...intake, isRoutine: false, status: "assigned" }), ["triage", "block"]);
    assert.deepEqual(recordActions({ ...intake, isRoutine: false, status: "backlog" }), ["triage", "block"]);
    assert.deepEqual(
      recordActions({ ...intake, sourceRoutineId: "routine-1", isRoutine: false, status: "assigned" }),
      ["retry", "block"],
    );
  });

  it("offers a running record a cancel and nothing else", () => {
    assert.deepEqual(recordActions({ ...assigned, isRoutine: false, status: "running" }), ["cancel"]);
    assert.deepEqual(recordActions({ ...assigned, isRoutine: true, status: "running" }), ["cancel"]);
  });

  it("offers a refused dispatch a retry, and the state actions beside it", () => {
    assert.deepEqual(recordActions({ ...assigned, isRoutine: false, status: "blocked" }), ["retry", "unblock"]);
    assert.deepEqual(recordActions({ ...assigned, isRoutine: false, status: "assigned" }), ["retry", "block"]);
  });

  it("carries the retired peek's state actions", () => {
    // Block/unblock and mark-done moved here when the record drawer became
    // the backlog's one detail surface; a review record is the only one that
    // can be marked done, and a finished one offers nothing.
    assert.deepEqual(recordActions({ ...assigned, isRoutine: false, status: "review" }), ["block", "done"]);
    assert.deepEqual(recordActions({ ...assigned, isRoutine: false, status: "done" }), []);
  });

  it("offers nothing on a task whose project is closed for work", () => {
    /* An archived or disabled project is a read-only room. The project board
       already hides Start and Accept there; without this the record drawer
       riding over that same project still offered Run, Block, Done, Edit and
       Delete — the rule enforced in one component and bypassed one click
       away. */
    const statuses = ["backlog", "assigned", "running", "waiting_for_human", "review", "blocked"] as const;
    for (const status of statuses) {
      for (const isRoutine of [true, false]) {
        assert.deepEqual(
          recordActions({ ...assigned, isRoutine, status }, { readOnly: true }),
          [],
          `${status}/${isRoutine ? "routine" : "task"} must offer nothing in a closed project`,
        );
      }
    }
    // An open project is unaffected.
    assert.deepEqual(recordActions({ ...assigned, isRoutine: false, status: "running" }, { readOnly: false }), ["cancel"]);
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
    const unassigned = { assignedAgentId: "", assignedTeamId: "", routineEnabled: true, projectId: "project-1" };
    assert.deepEqual(recordActions({ ...unassigned, isRoutine: true, status: "backlog" }), []);
    assert.deepEqual(recordActions({ ...unassigned, isRoutine: false, status: "blocked" }), ["unblock"]);
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
