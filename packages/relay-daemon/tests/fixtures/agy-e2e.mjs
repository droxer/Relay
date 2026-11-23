#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const model = "gemini-test";
if (args[0] === "models") {
  console.log(model + "\tGemini test");
  process.exit(0);
}
if (args[0] === "acp" && args[1] === "--help") process.exit(0);
if (args.join(" ") !== "acp") throw new Error("Expected agy acp with native permissions");

const write = (frame) => console.log(JSON.stringify({ jsonrpc: "2.0", ...frame }));
const respond = (id, result) => write({ id, result });
const fail = (id, message) => write({ id, error: { code: -32603, message } });
let sessionId;
let modelPinned = false;
let resumed = false;
let pending;
const emit = (update) => write({ method: "session/update", params: { sessionId, update } });
const finish = (id, text) => {
  for (const part of [text.slice(0, 10), text.slice(10)]) {
    emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: part } });
  }
  respond(id, {
    stopReason: "end_turn",
    usage: { inputTokens: 13, outputTokens: 5, cachedReadTokens: 70, cachedWriteTokens: 0 },
  });
};
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line);
  switch (method) {
    case "initialize":
      if (params.protocolVersion !== 1) throw new Error("Expected ACP version 1");
      respond(id, { protocolVersion: 1 });
      break;
    case "session/new":
      if (realpathSync(params.cwd) !== process.cwd()) throw new Error("The ACP workspace did not match the process cwd.");
      sessionId = randomUUID();
      respond(id, { sessionId });
      break;
    case "session/resume":
      if (existsSync(".discard-conversation")) {
        fail(id, "Conversation not found");
        break;
      }
      sessionId = params.sessionId;
      resumed = true;
      respond(id, { sessionId });
      break;
    case "session/set_model":
      if (params.sessionId !== sessionId || params.modelId !== model) throw new Error("Expected the pinned model");
      modelPinned = true;
      respond(id, {});
      break;
    case "session/prompt": {
      if (!modelPinned || params.sessionId !== sessionId || params.prompt[0].type !== "text") throw new Error("Invalid ACP session prompt");
      const prompt = params.prompt[0].text;
      const task = prompt.split("[User]\n").at(-1);
      if (task.includes("Remember this marker")) {
        const image = params.prompt[1];
        if (image?.type !== "image" || image.mimeType !== "image/png" || !image.data.startsWith("iVBORw0KGgo")) {
          throw new Error("Expected the attached PNG in the ACP prompt");
        }
      }
      if (task.includes("RELAY_AGY_FAILURE")) {
        fail(id, "Provider refused the run");
        break;
      }
      if (task.includes("RELAY_AGY_APPROVAL")) {
        pending = id;
        const toolCall = { sessionUpdate: "tool_call", toolCallId: "command-1", name: "run_command",
          kind: "execute", title: "printf RELAY_AGY_APPROVAL", rawInput: { CommandLine: "printf RELAY_AGY_APPROVAL" } };
        emit(toolCall);
        write({ id: "approval", method: "session/request_permission", params: { sessionId, toolCall, options: [
          { optionId: "once", kind: "allow_once", name: "Allow" },
          { optionId: "always", kind: "allow_always", name: "Always allow" },
          { optionId: "deny", kind: "reject_once", name: "Deny" },
        ] } });
        break;
      }
      let reply = "RELAY_AGY_FIRST";
      if (task.includes("RELAY_AGY_FOLLOW_UP")) {
        reply = resumed ? "RELAY_AGY_RESUMED" : prompt.includes("RELAY_AGY_FIRST") && prompt.includes("RELAY_AGY_RESUMED")
          ? "RELAY_AGY_FALLBACK"
          : "RELAY_AGY_CONTEXT_LOST";
      }
      finish(id, reply);
      break;
    }
    default:
      if (id !== "approval" || result?.outcome?.optionId !== "deny" || !pending) {
        throw new Error("The fixture did not receive the expected one-shot denial.");
      }
      finish(pending, "RELAY_AGY_DENIED");
      pending = undefined;
  }
}
