import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyThreadKindFilter } from "../src/lib/threadKindFilter.ts";

type Item = { id: string; origin?: { kind: string } };

const task: Item = { id: "t", origin: { kind: "backlog" } };
const routine: Item = { id: "r", origin: { kind: "routine" } };
const chat: Item = { id: "c" };

describe("applyThreadKindFilter", () => {
  it("keeps every thread for all", () => {
    assert.deepEqual(applyThreadKindFilter("all", [task, chat]).map((i) => i.id), ["t", "c"]);
  });
  it("keeps backlog and routine threads for tasks", () => {
    assert.deepEqual(applyThreadKindFilter("tasks", [task, routine, chat]).map((i) => i.id), ["t", "r"]);
  });
  it("keeps threads with no origin for chats", () => {
    assert.deepEqual(applyThreadKindFilter("chats", [task, routine, chat]).map((i) => i.id), ["c"]);
  });
});
