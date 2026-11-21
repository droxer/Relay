#!/usr/bin/env node
// A controlled Codex app-server. Each reply advances the same turn.
const { createInterface } = require("node:readline");
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");

const threadId = "permission-thread";
const turnId = "permission-turn";
const scope = { threadId, turnId };
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const steps = [
  ["inherited", "item/commandExecution/requestApproval", { command: "echo inherited" }],
  ["first-question", "item/tool/requestUserInput", { questions: [{ id: "color", question: "Which color?" }] }],
  ["pending", "item/commandExecution/requestApproval", { command: "echo pending" }],
  ["second-question", "item/tool/requestUserInput", { questions: [{ id: "shape", question: "Which shape?" }] }],
  ["restored", "item/commandExecution/requestApproval", { command: "echo restored" }],
];
let index = 0;
let reportPath;
let runId;

function next() {
  const step = steps[index];
  if (!step) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify({
      runId, status: "done", work: { status: "done", evidence: ["Received all five permission replies"] },
    }));
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
    return;
  }
  const [id, method, params] = step;
  send({ id, method, params: { ...scope, itemId: id, ...params } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params, result } = JSON.parse(line);
  if (method === "initialize") send({ id, result: {} });
  if (method === "thread/start" || method === "thread/resume") send({ id, result: { thread: { id: threadId } } });
  if (method === "turn/start") {
    const prompt = params.input[0].text;
    reportPath = prompt.match(/When you stop, write `([^`]+)` as JSON/)?.[1];
    runId = prompt.match(/Include "runId": "([^"]+)"/)?.[1];
    send({ id, result: { turn: { id: turnId } } });
    next();
  }
  if (!method && id === steps[index]?.[0]) {
    send({ method: "item/completed", params: {
      ...scope, item: { id: `reply-${id}`, type: "agentMessage", text: `${id}: ${JSON.stringify(result)}` },
    } });
    index += 1;
    next();
  }
});
