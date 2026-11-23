import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { asRecord, MethodNotFound, withAcpChild } from "./acp-connection.js";
import { answerPermissionRequest, RunJsonWriter, SessionUpdateTranslator } from "./acp-session-updates.js";
import { askBroker, NATIVE_RUNTIME_STARTUP_TIMEOUT_MS, runtimeEnv } from "./protocol.js";

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
      const session = asRecord(values.resume
        ? await connection.request("session/resume", { ...workspace, sessionId: values.resume })
        : await connection.request("session/new", workspace));
      if (typeof session.sessionId !== "string" || !session.sessionId || (values.resume && session.sessionId !== values.resume)) {
        throw new Error("Antigravity ACP returned an unexpected session ID.");
      }
      sessionId = session.sessionId;
      writer.session(sessionId);
      if (values.model) await connection.request("session/set_model", { sessionId, modelId: values.model });
      clearTimeout(timer);
      writer.started();
      const result = asRecord(await connection.request("session/prompt", { sessionId, prompt }));
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
