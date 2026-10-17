// The normalized permission protocol every runtime adapter speaks to the
// run's broker (../permission-broker.ts). An adapter only translates its
// runtime's native approval request into a PermissionQuestion and the answer
// back; the broker owns asking a person. Wire: one newline-terminated JSON
// request `{secret, kind, toolName, input, toolUseId?, reason?}` per
// connection, one newline-terminated `{behavior, message?}` reply.
import { connect } from "node:net";

export type PermissionQuestionKind = "command" | "file_change" | "tool";

/** One tool use a runtime wants a person to approve. Keep `input` compact. */
export interface PermissionQuestion {
  kind: PermissionQuestionKind;
  /** Shown to the person, e.g. "Bash", "apply_patch", "Write". */
  toolName: string;
  input: unknown;
  toolUseId?: string;
  reason?: string;
}

export interface PermissionAnswer {
  behavior: "allow" | "deny";
  /** Why it was denied, when known. */
  message?: string;
}

export const BROKER_UNAVAILABLE = "Relay could not ask a person for permission";

/**
 * The environment for the runtime an adapter launches: the adapter's own,
 * minus the broker's address and secret. The agent's tools inherit the
 * runtime's environment, and an agent that can reach the broker can put
 * questions of its own in front of the person.
 */
export function runtimeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("RELAY_PERMISSION_")));
}

/**
 * Asks the broker named by RELAY_PERMISSION_SOCKET / RELAY_PERMISSION_SECRET.
 * Never rejects: anything that keeps the question from a person is a denial.
 */
export async function askBroker(question: PermissionQuestion, env: NodeJS.ProcessEnv = process.env): Promise<PermissionAnswer> {
  const socketPath = env.RELAY_PERMISSION_SOCKET;
  const secret = env.RELAY_PERMISSION_SECRET;
  if (!socketPath || !secret) return deny(`${BROKER_UNAVAILABLE}: the permission broker is not configured.`);
  try {
    return await exchange(socketPath, `${JSON.stringify({ secret, ...question })}\n`);
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
  const parsed = JSON.parse(line) as Partial<{ behavior: string; message: string }>;
  if (parsed.behavior === "allow") return { behavior: "allow" };
  return deny(typeof parsed.message === "string" && parsed.message ? parsed.message : "Denied by Relay.");
}

function deny(message: string): PermissionAnswer {
  return { behavior: "deny", message };
}
