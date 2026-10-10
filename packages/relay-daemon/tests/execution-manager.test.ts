import assert from "node:assert/strict";
import test from "node:test";
import { setSessionBox } from "../src/box.js";
import { BoxLiteExecutionManager } from "../src/execution.js";
import { GUEST_PROCESS_SUPERVISOR } from "../src/guest-process-supervisor.js";

test("BoxLite adapter supervises the workload and signals its guardian without killing it", async () => {
  const controller = new AbortController();
  let finish!: (result: { exitCode: number }) => void;
  const exit = new Promise<{ exitCode: number }>(resolve => { finish = resolve; });
  const signals: number[] = [];
  let hardKills = 0;
  const chunks: Array<string | null> = ["captured before exit", null];
  setSessionBox({
    exec: async (command: string, args: string[], env: Array<[string,string]>, _tty: unknown, _user: unknown, _timeout: unknown, cwd: string) => {
      assert.equal(command, "node");
      assert.deepEqual(args, ["-e", GUEST_PROCESS_SUPERVISOR, "bash", "-lc", "work"]);
      assert.deepEqual(env, [["TEST_CONTEXT", "value"]]);
      assert.equal(cwd, "/workspace/thread");
      controller.abort();
      return {
        stdout: async () => ({ next: async () => chunks.shift() ?? null }),
        stderr: async () => ({ next: async () => null }),
        wait: async () => exit,
        signal: async (signal: number) => { signals.push(signal); finish({ exitCode: 130 }); },
        kill: async () => { hardKills++; },
      };
    },
  });
  try {
    const result = await new BoxLiteExecutionManager().execStream("bash", ["-lc", "work"], {
      cwd: "/workspace/thread", env: { TEST_CONTEXT: "value" }, signal: controller.signal,
    });
    assert.deepEqual(signals, [15]);
    assert.equal(hardKills, 0, "the guardian must retain ownership of descendant cleanup");
    assert.equal(result.stdout, "captured before exit");
    assert.equal(result.error_message, "Execution cancelled.");
  } finally { setSessionBox(null); }
});
