import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(`web/src/${path}`, "utf8");

const page = read("components/RoutinesPage.tsx");
const detail = read("components/task-board/RoutineDetail.tsx");
const drawer = read("components/task-board/TaskDrawer.tsx");
const form = read("components/task-board/TaskBoardForm.tsx");
const styles = read("styles/backlog-list.css");
const responsive = read("styles/responsive.css");

/**
 * The routine detail pane — where a routine is read and edited now that the
 * board no longer opens a drawer over itself for its own records.
 */
describe("routine detail pane", () => {
  it("mounts the same form the backlog's drawer does", () => {
    // One form, two chromes. A second copy of these fields would be two
    // surfaces to keep in step for one record.
    assert.match(detail, /<TaskBoardForm\b/);
    assert.match(drawer, /<TaskBoardForm\b/);
    assert.match(form, /export function TaskBoardForm\(/);
    // The drawer keeps nothing but its chrome.
    assert.doesNotMatch(drawer, /<Field\b|AssignmentField/);
    // A pane has nothing to dismiss to, so the Cancel button is optional.
    assert.match(form, /onCancel\?: \(\) => void/);
    assert.match(form, /\{onCancel \? \(/);
    assert.doesNotMatch(detail, /onCancel=/);
  });

  it("prints the record's facts in the shared band, once", () => {
    assert.match(detail, /<RecordBand facts=\{bandFacts\}/);
    for (const fact of ["ref", "state", "cadence", "next-run"]) {
      assert.match(detail, new RegExp(`key: "${fact}"`));
    }
    // The rail and the pane never restate each other's state word as a badge.
    assert.doesNotMatch(detail, /RoutineStateBadge/);
  });

  it("drafts and opens routines through the path", () => {
    assert.match(page, /routineId: string \| null/);
    assert.match(page, /onSelectRoutine\(NEW_ROUTINE_ID\)/);
    // A saved draft becomes a record, and the address follows it.
    assert.match(page, /onSelectRoutine\(created\.id\)/);
    // Loaded once per record: a poll must not overwrite a half-typed edit.
    assert.match(page, /loadedRoutineId\.current === routineId/);
    // Saving squares the baseline, or the navigation guard would challenge
    // the next click on a record that is no longer dirty.
    assert.match(page, /setFormBaseline\(form\);/);
  });

  it("gives the pane a way back and a title at phone width", () => {
    assert.match(detail, /className="routine-mobile-back"/);
    assert.match(styles, /\.routine-mobile-back \{\s*display: none;/);
    // Work routes clip their in-page title on mobile because the topbar names
    // the route — but this header names the RECORD, so it opts back in.
    assert.match(responsive, /\.routine-detail \.page-header-lead,?\s*\{[\s\S]{0,80}position: static;/);
  });

  it("shows one list at phone width, not the rail and the table both", () => {
    // Below the tier the rail is gone in BOTH views: the table is the list
    // there (it keeps selection, dispatch and — via the bar — the rail's
    // search and state), and an open record is the whole screen.
    assert.match(styles, /@media \(max-width: 820px\)[\s\S]{0,600}\.routine-roster \{\s*\n\s*display: none;/);
  });
});
