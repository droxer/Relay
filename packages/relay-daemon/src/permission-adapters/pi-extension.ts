// Pi adapter: a Pi extension (`pi --extension <this script>`) whose blocking
// `tool_call` hook puts every command and edit in front of a person through
// the run's permission broker. Pi has no permission system of its own, so this
// gives it the posture Claude's default has: reads pass, everything else asks.
//
// Pi loads the script itself (through jiti, in every mode including
// `--mode json` and `-p`), so this file stays plain ESM with `node:*` imports
// and the relative protocol import only, and never touches `ctx.ui`. The
// broker's address file is read once and removed from the process
// environment before any tool runs: Pi's bash tool inherits process.env, and
// an agent that can reach the broker can put questions of its own in front of
// the person. Verified against Pi 0.73.1 (`tool_call` carries `toolName`,
// `toolCallId`, `input`; returning `{ block, reason }` stops the call).
import { BROKER_UNAVAILABLE, askBroker, type PermissionAnswer, type PermissionQuestion } from "./protocol.js";

/** The slice of Pi's `tool_call` event this extension reads. */
export interface PiToolCallEvent {
  toolName: string;
  toolCallId?: string;
  input: unknown;
}

/** What a `tool_call` handler may return: block with a reason, or let the call run. */
export type PiToolCallVerdict = { block: true; reason?: string } | undefined;

export type PiToolCallHandler = (event: PiToolCallEvent, ctx?: unknown) => Promise<PiToolCallVerdict> | PiToolCallVerdict;

/** The slice of Pi's ExtensionAPI this extension uses; typed structurally so the daemon never depends on the Pi package. */
export interface PiExtensionApi {
  on(event: "tool_call", handler: PiToolCallHandler): unknown;
}

export type AskBroker = (question: PermissionQuestion) => Promise<PermissionAnswer>;

/** Pi's built-in tools that only read; they never ask. */
export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
export const DEFAULT_DENIAL = "Denied by the user in Relay.";
/** Longest preview of file content carried in a question. */
export const PREVIEW_LIMIT = 500;

/** Translates one Pi tool call into the question a person sees, or nothing when it needs no answer. */
export function questionFor(event: PiToolCallEvent): PermissionQuestion | undefined {
  const toolName = event.toolName;
  if (READ_ONLY_TOOLS.has(toolName)) return undefined;
  const input = record(event.input);
  const toolUseId = typeof event.toolCallId === "string" && event.toolCallId ? { toolUseId: event.toolCallId } : {};
  switch (toolName) {
    case "bash":
      return {
        kind: "command",
        toolName,
        input: { command: text(input.command), ...(input.timeout !== undefined ? { timeout: input.timeout } : {}) },
        ...toolUseId,
      };
    case "write":
      return { kind: "file_change", toolName, input: { path: text(input.path), content: preview(input.content) }, ...toolUseId };
    case "edit":
      return { kind: "file_change", toolName, input: { path: text(input.path), ...editPreview(input) }, ...toolUseId };
    default:
      return { kind: "tool", toolName, input: event.input, ...toolUseId };
  }
}

/** Current Pi sends `edits: [{oldText, newText}]`; older models and Pi versions send one `oldText`/`newText` pair. */
function editPreview(input: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(input.edits)) {
    return { edits: input.edits.map((edit) => {
      const pair = record(edit);
      return { oldText: preview(pair.oldText), newText: preview(pair.newText) };
    }) };
  }
  return { oldText: preview(input.oldText), newText: preview(input.newText) };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
}

function preview(value: unknown): string {
  const full = text(value);
  return full.length > PREVIEW_LIMIT ? `${full.slice(0, PREVIEW_LIMIT)}… (${full.length - PREVIEW_LIMIT} more characters)` : full;
}

/** The handler's verdict for one broker answer: an allowance runs the tool, anything else blocks it with the reason. */
export function verdictFor(answer: PermissionAnswer): PiToolCallVerdict {
  if (answer.behavior === "allow") return undefined;
  return { block: true, reason: answer.message || DEFAULT_DENIAL };
}

/** The `tool_call` handler: asks the broker about every call that needs a person, blocking whenever it cannot. */
export function createToolCallHandler(ask: AskBroker): PiToolCallHandler {
  return async (event) => {
    const question = questionFor(event);
    if (!question) return undefined;
    try {
      return verdictFor(await ask(question));
    } catch (error) {
      return { block: true, reason: `${BROKER_UNAVAILABLE}: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
}

/**
 * Takes the broker's address out of the process environment and returns a
 * copy for the extension alone, so no tool Pi runs can see it.
 */
export function captureBrokerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const captured: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(env)) {
    if (!key.startsWith("RELAY_PERMISSION_")) continue;
    captured[key] = env[key];
    delete env[key];
  }
  return captured;
}

/** The extension factory Pi calls once at load. */
export default function relayPermissionExtension(pi: PiExtensionApi): void {
  const brokerEnv = captureBrokerEnv();
  pi.on("tool_call", createToolCallHandler((question) => askBroker(question, brokerEnv)));
}
