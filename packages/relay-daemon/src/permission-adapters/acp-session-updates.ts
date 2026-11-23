import { isDeepStrictEqual } from "node:util";
import { asRecord, contentText, permissionOptions, selected } from "./acp-connection.js";
import type { PermissionAnswer, PermissionQuestion, PermissionQuestionKind } from "./protocol.js";

/** Asks about one request until the prompt ends or a person answers. */
export type AskBroker = (question: PermissionQuestion, signal?: AbortSignal) => Promise<PermissionAnswer>;

interface ToolState {
  status: "pending" | "running" | "completed" | "error";
  input?: unknown;
  output?: string;
  error?: string;
  title?: string;
}

/** Prints run-format events, forwarding assistant chunks as append-only text deltas. */
export class RunJsonWriter {
  constructor(private readonly out: { write(text: string): unknown }) {}

  assistantDelta(type: "text" | "reasoning", text: string, messageId: unknown): void {
    if (!text) return;
    this.line({
      type, delta: true,
      part: { type, text, ...(typeof messageId === "string" ? { messageID: messageId } : {}) },
    });
  }

  toolUse(callID: string, tool: string, state: ToolState): void {
    this.line({ type: "tool_use", part: { callID, tool, state } });
  }

  error(message: string): void {
    this.line({ type: "error", error: { message } });
  }

  session(sessionId: string): void {
    this.line({ type: "relay.runtime.session", session_id: sessionId });
  }

  usage(usage: Record<string, unknown>): void {
    this.line({ type: "relay.runtime.usage", usage });
  }

  started(): void {
    this.line({ type: "relay.runtime.started" });
  }

  private line(event: Record<string, unknown>): void {
    this.out.write(`${JSON.stringify(event)}\n`);
  }
}

interface KnownToolCall {
  name: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  status: ToolState["status"];
}

/** Translates `session/update` notifications into run events, and remembers tool calls for their permission requests. */
export class SessionUpdateTranslator {
  private readonly calls = new Map<string, KnownToolCall>();

  constructor(private readonly writer: RunJsonWriter) {}

  toolCall(id: string): KnownToolCall | undefined {
    return this.calls.get(id);
  }

  apply(update: Record<string, unknown>): void {
    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
      const type = update.sessionUpdate === "agent_thought_chunk" ? "reasoning" : "text";
      this.writer.assistantDelta(type, contentText(update.content), update.messageId);
      return;
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.applyToolCall(update);
    }
  }

  private applyToolCall(update: Record<string, unknown>): void {
    const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
    if (!id) return;
    const known = this.calls.get(id);
    if (known?.status === "completed" || known?.status === "error") return;
    const call: KnownToolCall = known ? { ...known } : { name: "tool", status: "pending" };
    if (typeof update.name === "string" && update.name) call.name = update.name;
    if (typeof update.title === "string" && update.title) call.title = update.title;
    if (typeof update.kind === "string") call.kind = update.kind;
    if (update.rawInput !== undefined) call.rawInput = update.rawInput;
    if (update.status === "in_progress") call.status = "running";
    if (update.status === "completed") call.status = "completed";
    if (update.status === "failed") call.status = "error";
    if (isDeepStrictEqual(known, call)) return;
    this.calls.set(id, call);
    const output = call.status === "completed" || call.status === "error" ? outputText(update) : "";
    // `opencode run` names a failed tool's message `error`, not `output`.
    this.writer.toolUse(id, call.name, {
      status: call.status,
      ...(call.rawInput !== undefined ? { input: call.rawInput } : {}),
      ...(output ? (call.status === "error" ? { error: output } : { output }) : {}),
      ...(call.title ? { title: call.title } : {}),
    });
  }
}

/** One `session/request_permission` in, the ACP outcome to send back. Never selects an `always` option. */
export async function answerPermissionRequest(
  params: Record<string, unknown>,
  translator: SessionUpdateTranslator,
  ask: AskBroker,
): Promise<Record<string, unknown>> {
  const options = permissionOptions(params.options);
  const toolCall = asRecord(params.toolCall);
  const toolCallId = typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : undefined;
  const known = toolCallId ? translator.toolCall(toolCallId) : undefined;
  const toolName = (typeof toolCall.name === "string" && toolCall.name) || known?.name || "tool";
  const title = (typeof toolCall.title === "string" && toolCall.title) || known?.title;
  const acpKind = typeof toolCall.kind === "string" ? toolCall.kind : known?.kind;
  const question: PermissionQuestion = {
    kind: questionKind(acpKind),
    toolName,
    input: toolCall.rawInput ?? known?.rawInput ?? {},
    ...(toolCallId ? { toolUseId: toolCallId } : {}),
    ...(title ? { reason: title } : {}),
  };
  let answer: PermissionAnswer;
  try {
    answer = await ask(question);
  } catch {
    answer = { behavior: "deny" };
  }
  return selected(options, answer.behavior === "allow" ? "allow_once" : "reject_once");
}

/** ACP tool kinds mapped onto the broker's question kinds; anything else is a generic tool. */
export function questionKind(acpKind: string | undefined): PermissionQuestionKind {
  if (acpKind === "execute") return "command";
  if (acpKind === "edit" || acpKind === "delete" || acpKind === "move") return "file_change";
  return "tool";
}

function outputText(update: Record<string, unknown>): string {
  if (update.rawOutput !== undefined) {
    return typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput) ?? "";
  }
  return contentText(update.content);
}
