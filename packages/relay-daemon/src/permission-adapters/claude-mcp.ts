// Claude adapter: the stdio MCP server Claude Code launches through
// `--permission-prompt-tool`.
// It owns no policy: every `approve` call is relayed to the run's permission
// broker in the daemon, which asks a person through Relay. stdout carries
// protocol JSON only; diagnostics go to stderr.
//
// Claude's own AskUserQuestion reaches this server like any tool: the
// person's picks go back as `answers` on `updatedInput`, the way an
// interactive session fills them in. Verified against Claude Code 2.1.292.
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { PermissionAnswers, PermissionQuestionItem } from "relay-core";
import { BROKER_UNAVAILABLE, askBroker, type PermissionAnswer, type PermissionQuestion } from "./protocol.js";

/** Asks the broker about one tool use; injectable for tests. */
export type AskBroker = (question: PermissionQuestion) => Promise<PermissionAnswer>;

export const PERMISSION_TOOL_NAME = "approve";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const APPROVE_TOOL = {
  name: PERMISSION_TOOL_NAME,
  description: "Ask a person in Relay whether a tool use may proceed.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
};

/** One JSON-RPC message in, at most one response out (undefined for notifications). */
export async function handleMessage(message: JsonRpcRequest, ask: AskBroker): Promise<Record<string, unknown> | undefined> {
  const id = message.id;
  const isNotification = id === undefined || id === null;
  switch (message.method) {
    case "initialize": {
      const requested = message.params?.protocolVersion;
      return result(id, {
        protocolVersion: typeof requested === "string" && requested ? requested : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "relay", version: "0.1.0" },
      });
    }
    case "notifications/initialized":
      return undefined;
    case "ping":
      return isNotification ? undefined : result(id, {});
    case "tools/list":
      return result(id, { tools: [APPROVE_TOOL] });
    case "tools/call":
      return result(id, await callTool(message.params ?? {}, ask));
    default:
      if (isNotification) return undefined;
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } };
  }
}

async function callTool(params: Record<string, unknown>, ask: AskBroker): Promise<Record<string, unknown>> {
  if (params.name !== PERMISSION_TOOL_NAME) {
    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${String(params.name)}` }] };
  }
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const input = args.input ?? {};
  const toolName = typeof args.tool_name === "string" ? args.tool_name : "";
  const toolUseId = typeof args.tool_use_id === "string" ? args.tool_use_id : undefined;
  let decision: PermissionAnswer;
  try {
    decision = await ask(claudeQuestion(toolName, input, toolUseId));
  } catch (error) {
    decision = { behavior: "deny", message: `${BROKER_UNAVAILABLE}: ${errorMessage(error)}` };
  }
  const answer = decision.behavior === "allow"
    ? { behavior: "allow", updatedInput: withAnswers(toolName, input, decision.answers) }
    : { behavior: "deny", message: decision.message ?? "Denied by Relay." };
  return { content: [{ type: "text", text: JSON.stringify(answer) }] };
}

const CLAUDE_COMMAND_TOOLS = new Set(["Bash", "BashOutput", "KillShell"]);
const CLAUDE_FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
export const ASK_USER_QUESTION = "AskUserQuestion";

function claudeQuestionKind(toolName: string): PermissionQuestion["kind"] {
  if (CLAUDE_COMMAND_TOOLS.has(toolName)) return "command";
  return CLAUDE_FILE_TOOLS.has(toolName) ? "file_change" : "tool";
}

/** The broker question for one tool use; AskUserQuestion carries its questions. */
export function claudeQuestion(toolName: string, input: unknown, toolUseId?: string): PermissionQuestion {
  const base = { toolName, input, ...(toolUseId ? { toolUseId } : {}) };
  const questions = toolName === ASK_USER_QUESTION ? askUserQuestions(input) : undefined;
  return questions ? { kind: "question", ...base, questions } : { kind: claudeQuestionKind(toolName), ...base };
}

/** AskUserQuestion's `questions`, keyed by their text — that is how Claude keys the answers. */
function askUserQuestions(input: unknown): PermissionQuestionItem[] | undefined {
  const raw = record(input).questions;
  if (!Array.isArray(raw)) return undefined;
  const questions = raw.flatMap((item) => {
    const question = record(item);
    const text = typeof question.question === "string" ? question.question.trim() : "";
    if (!text) return [];
    const options = (Array.isArray(question.options) ? question.options : []).flatMap((option) => {
      const label = record(option).label;
      const description = record(option).description;
      return typeof label === "string" && label.trim()
        ? [{ label: label.trim(), ...(typeof description === "string" && description.trim() ? { description: description.trim() } : {}) }]
        : [];
    });
    return [{ id: text, text, options, ...(question.multiSelect === true ? { multiSelect: true } : {}) }];
  });
  return questions.length ? questions : undefined;
}

/** Claude reads a question's answer from `answers[question]`; several picks join with ", ". */
function withAnswers(toolName: string, input: unknown, answers: PermissionAnswers | undefined): unknown {
  if (toolName !== ASK_USER_QUESTION || !answers) return input;
  const joined = Object.fromEntries(Object.entries(answers).map(([question, picks]) => [question, picks.join(", ")]));
  return { ...record(input), answers: joined };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function result(id: JsonRpcRequest["id"], value: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serve(ask: AskBroker): void {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (response: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  };
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(line) as JsonRpcRequest;
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    // Calls run concurrently: Claude may ask about several tool uses at once.
    handleMessage(message, ask).then((response) => {
      if (response) write(response);
    }).catch((error: unknown) => {
      process.stderr.write(`relay permission prompt: ${errorMessage(error)}\n`);
      if (message.id !== undefined && message.id !== null) {
        write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Internal error" } });
      }
    });
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serve((question) => askBroker(question));
}
