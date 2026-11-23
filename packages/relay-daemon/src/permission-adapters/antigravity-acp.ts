import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { asRecord, MethodNotFound, withAcpChild } from "./acp-connection.js";
import { answerPermissionRequest, RunJsonWriter, SessionUpdateTranslator } from "./acp-session-updates.js";
import { askBroker, listenForLiveMessages, NATIVE_RUNTIME_STARTUP_TIMEOUT_MS, runtimeEnv } from "./protocol.js";

// Give the ACP peer less time to acknowledge than the broker's 30-second deadline.
const STEER_REPLY_TIMEOUT_MS = 25_000;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cwd: { type: "string", default: process.cwd() },
      model: { type: "string" },
      prompt: { type: "string" },
      resume: { type: "string" },
      trusted: { type: "boolean" },
      image: { type: "string", multiple: true },
    },
  });
  if (values.prompt === undefined) throw new Error("--prompt is required");
  const prompt = [
    { type: "text", text: values.prompt },
    ...await Promise.all((values.image ?? []).map(async (attachment) => {
      const split = attachment.indexOf(":");
      return {
        type: "image",
        mimeType: attachment.slice(0, split),
        data: (await readFile(attachment.slice(split + 1))).toString("base64"),
      };
    })),
  ];

  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort(new Error("SIGTERM")));
  process.once("SIGINT", () => stop.abort(new Error("SIGINT")));
  const startup = new AbortController();
  const timer = setTimeout(() => startup.abort(new Error("Antigravity ACP did not start in time.")), NATIVE_RUNTIME_STARTUP_TIMEOUT_MS);
  const asks = new AbortController();
  const writer = new RunJsonWriter(process.stdout);
  const translator = new SessionUpdateTranslator(writer);
  let sessionId: string | undefined;
  try {
    await withAcpChild({
      label: "agy acp",
      command: "agy",
      args: values.trusted ? ["acp", "--dangerously-skip-permissions"] : ["acp"],
      cwd: values.cwd,
      env: runtimeEnv(),
      stderr: process.stderr,
      signal: AbortSignal.any([startup.signal, stop.signal]),
      onNotification(message) {
        if (message.method !== "session/update" || !sessionId || message.params?.sessionId !== sessionId) return;
        translator.apply(asRecord(message.params.update));
      },
      async onRequest(message) {
        if (message.method !== "session/request_permission") throw new MethodNotFound(`Unexpected Antigravity ACP method: ${message.method}`);
        if (!sessionId || message.params?.sessionId !== sessionId) return { outcome: { outcome: "cancelled" } };
        return await answerPermissionRequest(message.params, translator, (question) => askBroker(question, process.env, asks.signal));
      },
    }, async (connection) => {
      const init = asRecord(await connection.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "Relay", version: "1" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }));
      if (init.protocolVersion !== 1) throw new Error("Antigravity returned an unsupported ACP protocol version.");
      const workspace = { cwd: values.cwd, mcpServers: [] };
      if (values.resume) {
        const capabilities = asRecord(asRecord(init.agentCapabilities).sessionCapabilities);
        if (!capabilities.resume) throw new Error("Antigravity ACP does not support resuming sessions.");
        const resumed = asRecord(await connection.request("session/resume", { ...workspace, sessionId: values.resume }));
        if (resumed.sessionId !== undefined && resumed.sessionId !== values.resume) {
          throw new Error("Antigravity ACP returned an unexpected session ID.");
        }
        sessionId = values.resume;
      } else {
        const created = asRecord(await connection.request("session/new", workspace));
        if (typeof created.sessionId !== "string" || !created.sessionId) {
          throw new Error("Antigravity ACP did not return a session ID.");
        }
        sessionId = created.sessionId;
      }
      writer.session(sessionId);
      if (values.model) await connection.request("session/set_model", { sessionId, modelId: values.model });
      clearTimeout(timer);
      writer.started();
      const turn = connection.request("session/prompt", { sessionId, prompt });
      let acceptingSteer = true;
      let pendingSteer: Promise<unknown> | undefined;
      const listener = listenForLiveMessages(async ({ text }) => {
        if (!acceptingSteer || pendingSteer) throw new Error("Antigravity cannot take another message right now.");
        // Antigravity treats a concurrent prompt in the same ACP session as a steer.
        const timeout = new AbortController();
        pendingSteer = Promise.race([
          connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
          delay(STEER_REPLY_TIMEOUT_MS, undefined, { signal: timeout.signal, ref: false }).then(() => {
            throw new Error("Antigravity did not acknowledge the live message in time.");
          }),
        ]);
        try {
          const response = asRecord(await pendingSteer);
          if (response.stopReason !== "end_turn") throw new Error("Antigravity did not accept the live message.");
          return "steer";
        } finally {
          timeout.abort();
          pendingSteer = undefined;
        }
      });
      let result: Record<string, unknown>;
      try {
        result = asRecord(await turn);
      } finally {
        acceptingSteer = false;
        // Let the broker receive the answer when the turn and steer settle together.
        await pendingSteer?.catch(() => undefined);
        listener?.close();
      }
      const usage = asRecord(result.usage);
      writer.usage({
        input: usage.inputTokens, output: usage.outputTokens,
        cacheRead: usage.cachedReadTokens, cacheWrite: usage.cachedWriteTokens,
      });
      if (result.stopReason !== "end_turn") throw new Error(`Antigravity stopped the turn (${String(result.stopReason ?? "unknown")}).`);
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writer.error(detail);
    process.stderr.write(`Antigravity ACP: ${detail}\n`);
    process.exitCode = stop.signal.aborted ? 130 : 1;
  } finally {
    asks.abort();
    clearTimeout(timer);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`Antigravity ACP: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
