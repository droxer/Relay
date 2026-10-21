// The normalized permission protocol every runtime adapter speaks to the
// run's broker (../permission-broker.ts). An adapter only translates its
// runtime's native approval request into a PermissionQuestion and the answer
// back; the broker owns asking a person. Wire: one newline-terminated JSON
// request `{secret, kind, toolName, input, toolUseId?, reason?, questions?}`
// per connection, one newline-terminated `{behavior, message?, answers?}`
// reply.
//
// An adapter finds the broker through RELAY_PERMISSION_FILE: a 0600 file in
// the broker's private directory holding `{socket, secret}`. Only the path
// rides on command lines and in process environments, never the secret.
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import type { PermissionAnswers, PermissionQuestionItem } from "relay-core";

export type PermissionQuestionKind = "command" | "file_change" | "tool" | "question";

/** One tool use a runtime wants a person to approve, or a question it asks them. Keep `input` compact. */
export interface PermissionQuestion {
  kind: PermissionQuestionKind;
  /** Shown to the person, e.g. "Bash", "apply_patch", "Write". */
  toolName: string;
  input: unknown;
  toolUseId?: string;
  reason?: string;
  /** For `kind: "question"`: what the runtime asks and the answers it offers. */
  questions?: PermissionQuestionItem[];
}

export interface PermissionAnswer {
  behavior: "allow" | "deny";
  /** Why it was denied, when known. */
  message?: string;
  /** The person's answers to a `question`, on allow. */
  answers?: PermissionAnswers;
}

/** What the broker's private file holds. */
export interface BrokerAddress {
  socket: string;
  secret: string;
}

export const BROKER_UNAVAILABLE = "Relay could not ask a person for permission";
export const BROKER_FILE_ENV = "RELAY_PERMISSION_FILE";

/**
 * The environment for the runtime an adapter launches: the adapter's own,
 * minus the broker's address. The agent's tools inherit the runtime's
 * environment, and an agent that can reach the broker can put questions of
 * its own in front of the person.
 */
export function runtimeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("RELAY_PERMISSION_")));
}

/** The broker named by RELAY_PERMISSION_FILE, or undefined when there is none to reach. */
export function brokerAddress(env: NodeJS.ProcessEnv = process.env): BrokerAddress | undefined {
  const file = env[BROKER_FILE_ENV];
  if (!file) return undefined;
  let parsed: Partial<BrokerAddress>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<BrokerAddress>;
  } catch {
    return undefined;
  }
  return typeof parsed.socket === "string" && typeof parsed.secret === "string" && parsed.socket && parsed.secret
    ? { socket: parsed.socket, secret: parsed.secret }
    : undefined;
}

/**
 * Asks the broker named by RELAY_PERMISSION_FILE.
 * Never rejects: anything that keeps the question from a person is a denial.
 */
export async function askBroker(question: PermissionQuestion, env: NodeJS.ProcessEnv = process.env): Promise<PermissionAnswer> {
  const address = brokerAddress(env);
  if (!address) return deny(`${BROKER_UNAVAILABLE}: the permission broker is not configured.`);
  try {
    return await exchange(address.socket, `${JSON.stringify({ secret: address.secret, ...question })}\n`);
  } catch (error) {
    return deny(`${BROKER_UNAVAILABLE}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function exchange(socketPath: string, request: string): Promise<PermissionAnswer> {
  return new Promise<PermissionAnswer>((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      outcome();
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      finish(() => resolve(parseAnswer(buffer.slice(0, newline))));
    });
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("close", () => finish(() => reject(new Error("the broker closed the connection without answering"))));
  });
}

function parseAnswer(line: string): PermissionAnswer {
  const parsed = JSON.parse(line) as Partial<{ behavior: string; message: string; answers: unknown }>;
  if (parsed.behavior === "allow") {
    const answers = parseAnswers(parsed.answers);
    return answers ? { behavior: "allow", answers } : { behavior: "allow" };
  }
  return deny(typeof parsed.message === "string" && parsed.message ? parsed.message : "Denied by Relay.");
}

/** Answers as `{questionId: [text, ...]}`, dropping anything shaped otherwise. */
export function parseAnswers(value: unknown): PermissionAnswers | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const answers: PermissionAnswers = {};
  for (const [id, given] of Object.entries(value as Record<string, unknown>)) {
    const list = (Array.isArray(given) ? given : [given]).filter((item): item is string => typeof item === "string" && item.trim() !== "");
    if (list.length) answers[id] = list;
  }
  return Object.keys(answers).length ? answers : undefined;
}

function deny(message: string): PermissionAnswer {
  return { behavior: "deny", message };
}
