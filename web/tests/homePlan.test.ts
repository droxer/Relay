import assert from "node:assert/strict";
import { it } from "node:test";
import { homeUpcoming, readyHomeTasks, homeBlockers, homeFocusItem } from "../src/lib/homePlan.js";
import type { RelayTaskListItem, ProjectRecord } from "../src/types.js";
import type { HomeItem } from "../src/lib/homeQueue.js";
const task = (id: string, extra: Partial<RelayTaskListItem> = {}) => ({ id, title: id, ownerUserId: "me", projectId: "p", status: "assigned", priority: "normal", assignedAgentId: "a", waitingOn: [], createdAt: "2026-10-01", updatedAt: "2026-10-01", ...extra }) as RelayTaskListItem;
const projects = [{ id: "p", enabled: true }] as ProjectRecord[];
it("suggests only personal, assigned, unblocked work in enabled projects, ordered by priority and due date", () => {
 const tasks = [task("normal"), task("high", {priority: "high"}), task("blocked", {waitingOn: ["x"]}), task("other", {assigneeUserId: "other"}), task("intake", {projectId: undefined}), task("unknown", {waitingOn: undefined, prerequisiteTaskIds: ["x"]}), task("routine", {isRoutine: true}), task("unassigned", {assignedAgentId: undefined}), task("queued", {dispatchOutcome: {state: "queued"}})];
 assert.deepEqual(readyHomeTasks(tasks, projects, "me").map(t=>t.id), ["high", "normal"]);
 assert.deepEqual(readyHomeTasks(tasks, [{...projects[0], archivedAt: "now"}], "me"), []);
});
it("includes today through six days later, ignores completed work and paused schedules, and uses calendar days", () => {
 const rows=homeUpcoming([task("today", {dueDate:"2026-10-31"}),task("last",{dueDate:"2026-11-06"}),task("later",{dueDate:"2026-11-07"}),task("old",{dueDate:"2026-10-30"}),task("done",{status:"done",dueDate:"2026-10-31"}),task("routine",{isRoutine:true,routineState:"active",routineNextRunAt:"2026-11-02T12:00:00Z"}),task("paused",{isRoutine:true,routineState:"paused",routineNextRunAt:"2026-11-02T12:00:00Z"})],"me","2026-10-31");
 assert.deepEqual(rows.map(r=>r.task.id),["today","routine","last"]);
});
it("shows only relevant shared blockers, preserves inaccessible references, and deduplicates prerequisites", () => {
 const mine=task("mine",{waitingOn:["shared","hidden"],waitingOnSummaries:[{id:"shared",title:"Shared",status:"running",ownerUserId:"other",canOpen:false}]});
 const rows=homeBlockers([mine,task("mine2",{waitingOn:["shared"],waitingOnSummaries:mine.waitingOnSummaries})],"me");
 assert.equal(rows.length,2);assert.equal(rows[0].dependents.length,2);assert.equal(rows[0].summary?.title,"Shared");assert.equal(rows[1].summary,undefined);
});
it("keeps unresolvable blocked work out of Start here but retains human decisions", () => {
 const blocked={kind:"blocked",key:"b",tier:"stuck",task:task("b")} as HomeItem;
 const overdue={kind:"overdue",key:"o",tier:"worth_doing",task:task("o")} as HomeItem;
 assert.equal(homeFocusItem([blocked,overdue])?.key,"o");
 assert.equal(homeFocusItem([blocked]),null);
});
