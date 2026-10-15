/* Structural guards for the high-traffic payloads.

   `apiJson<T>` used to hand the parsed body straight to the UI as `T`, so a
   backend that drifted (a renamed field, a list wrapped in an object) failed
   far from the cause — as `undefined.localeCompare` in a sort, or a blank
   rail. These guards check only what the UI dereferences without optional
   chaining, and leave every optional field alone: the backend adds fields
   freely, and over-validating would turn each of those additions into an
   outage. A guard narrows nothing — it returns the same object, typed. */

import type { RelaySession, RelayTask, SessionSummariesResponse, TasksResponse } from "../types.ts";

/** One place a body departed from the shape the UI relies on. `apiJson`
 *  turns it into a `RelayApiShapeError` naming the endpoint. */
export class ResponseShapeIssue extends Error {
  constructor(
    /** Path into the body, e.g. `sessions[3].updatedAt`; `response` is the root. */
    public readonly field: string,
    public readonly expected: string,
    public readonly received: string,
  ) {
    super(`${field} should be ${expected}, got ${received}`);
    this.name = "ResponseShapeIssue";
  }
}

export type ResponseGuard<T> = (value: unknown) => T;

const ROOT = "response";

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (value === undefined) return "nothing";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

function childPath(path: string, key: string): string {
  return path === ROOT ? key : `${path}.${key}`;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new ResponseShapeIssue(path, "an object", describeValue(value));
}

function expectArray(record: Record<string, unknown>, key: string, path: string): unknown[] {
  const value = record[key];
  if (Array.isArray(value)) return value;
  throw new ResponseShapeIssue(childPath(path, key), "an array", describeValue(value));
}

function expectStrings(record: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of keys) {
    if (typeof record[key] !== "string") {
      throw new ResponseShapeIssue(childPath(path, key), "a string", describeValue(record[key]));
    }
  }
}

/* Required fields, chosen from what the thread rail, transcript, and task
   board read unguarded: identity, status, the sort keys, and the label. */
const SESSION_STRINGS = ["id", "status", "taskGoal", "createdAt", "updatedAt"] as const;
/** A full session also carries the lists the transcript walks. */
const SESSION_ARRAYS = ["events", "agentRuns"] as const;
const TASK_STRINGS = ["id", "title", "status", "createdAt", "updatedAt"] as const;
const TASK_ARRAYS = ["linkedSessionIds"] as const;

function checkSessionSummary(value: unknown, path: string): void {
  expectStrings(expectRecord(value, path), SESSION_STRINGS, path);
}

function checkTask(value: unknown, path: string): void {
  const record = expectRecord(value, path);
  expectStrings(record, TASK_STRINGS, path);
  for (const key of TASK_ARRAYS) expectArray(record, key, path);
}

function checkEach(items: unknown[], path: string, check: (item: unknown, path: string) => void): void {
  items.forEach((item, index) => check(item, `${path}[${index}]`));
}

export const sessionSummariesGuard: ResponseGuard<SessionSummariesResponse> = (value) => {
  const body = expectRecord(value, ROOT);
  checkEach(expectArray(body, "sessions", ROOT), "sessions", checkSessionSummary);
  return body as unknown as SessionSummariesResponse;
};

export const sessionGuard: ResponseGuard<RelaySession> = (value) => {
  const body = expectRecord(value, ROOT);
  expectStrings(body, SESSION_STRINGS, ROOT);
  for (const key of SESSION_ARRAYS) expectArray(body, key, ROOT);
  return body as unknown as RelaySession;
};

export const tasksGuard: ResponseGuard<TasksResponse> = (value) => {
  const body = expectRecord(value, ROOT);
  checkEach(expectArray(body, "tasks", ROOT), "tasks", checkTask);
  return body as unknown as TasksResponse;
};

export const taskGuard: ResponseGuard<RelayTask> = (value) => {
  checkTask(value, ROOT);
  return value as RelayTask;
};
