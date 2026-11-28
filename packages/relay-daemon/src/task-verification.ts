import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { StreamExecResult, TaskVerificationCheck, TaskVerificationResult } from "relay-core";
import { ExecutionCleanupError, withExecutionDeadline } from "./execution-deadline.js";
import { exitHooksFor } from "./execution-capture.js";
import type { ExecutionManager } from "./execution.js";

const gitExec = promisify(execFile);
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const pathComponent = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export type VerificationGuest = (directory: string, signal?: AbortSignal) => Promise<StreamExecResult>;

export async function runVerificationGuest(
  manager: ExecutionManager, runtime: unknown, boxName: string, directory: string, signal?: AbortSignal,
): Promise<StreamExecResult> {
  signal?.throwIfAborted();
  try {
    const guest = await manager.createSandbox(runtime, {
      rootfsPath: manager.ensureImage(() => undefined), boxName,
      volumes: [{ hostPath: directory, guestPath: "/relay-verification", readOnly: true }],
      env: [], workingDir: "/tmp", autoRemove: true, network: { mode: "disabled" },
    });
    manager.setActiveSandbox(guest);
    const check = async (): Promise<StreamExecResult> => {
      const prepared = await manager.execStream("bash", ["-c",
        `set -eu
read -r commit < /relay-verification/commit
format=sha1
if [ "\${#commit}" -eq 64 ]; then format=sha256; fi
mkdir /tmp/relay-candidate
cd /tmp/relay-candidate
git init -q --object-format="$format"
git index-pack --stdin < /relay-verification/candidate.pack
printf '%s\\n' "$commit" > .git/shallow
git reset --hard "$commit"`], { signal });
      if (prepared.exit_code !== 0) throw new Error("Could not check out the Git candidate.");
      return manager.execStream("bash", ["--noprofile", "--norc", "/relay-verification/check.sh"],
        { cwd: "/tmp/relay-candidate", signal });
    };
    return await withExecutionDeadline(check(), 120_000, "Task verification", signal);
  } finally {
    try {
      await withExecutionDeadline(manager.removeSandbox(runtime, boxName), 10_000, "Verification guest removal");
    } catch (error) {
      const hooks = exitHooksFor(signal);
      hooks?.onExitUnconfirmed?.();
      const release = hooks?.release;
      if (release && !release.aborted) {
        await new Promise<void>(resolve => release.addEventListener("abort", () => resolve(), { once: true }));
      }
      throw new ExecutionCleanupError("Verification guest removal was unconfirmed.", { cause: error });
    } finally {
      manager.setActiveSandbox(null);
    }
  }
}

async function git(workspace: string, argv: string[], limit: number, signal?: AbortSignal, stdin?: string): Promise<Buffer> {
  const pending = gitExec("git", ["--no-replace-objects", "-c", "core.fsmonitor=false", ...argv], {
    cwd: workspace, encoding: "buffer", maxBuffer: limit, timeout: 30_000, signal,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
  });
  if (stdin !== undefined) {
    pending.child.stdin?.on("error", () => undefined);
    pending.child.stdin?.end(stdin);
  }
  const { stdout } = await pending;
  return stdout;
}

export async function verificationCandidate(workspace: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const root = (await git(workspace, ["rev-parse", "--show-toplevel"], 4096, signal)).toString().trim();
    const worktree = await realpath(workspace);
    if (await realpath(root) !== worktree) return null;
    const gitDir = (await git(workspace, ["rev-parse", "--absolute-git-dir"], 4096, signal)).toString().trim();
    if (await realpath(gitDir) !== join(worktree, ".git")) return null;
    const commit = (await git(workspace, ["rev-parse", "--verify", "HEAD^{commit}"], 4096, signal)).toString().trim();
    return commitPattern.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

async function candidatePack(workspace: string, commit: string, signal?: AbortSignal): Promise<Buffer> {
  const tree = (await git(workspace, ["rev-parse", `${commit}^{tree}`], 4096, signal)).toString().trim();
  const entries = await git(workspace, ["ls-tree", "--full-tree", "-r", "-t", "-z", commit], 4 * 1024 * 1024, signal);
  const objects = new Set([commit, tree]);
  for (const entry of entries.toString().split("\0").filter(Boolean)) {
    const object = /^\d{6} (blob|tree) ([a-f0-9]+)\t/.exec(entry)?.[2];
    if (!object || !commitPattern.test(object)) throw new Error("The candidate has unsupported Git tree entries.");
    objects.add(object);
  }
  return git(workspace, ["pack-objects", "--stdout"], 32 * 1024 * 1024, signal, [...objects].join("\n") + "\n");
}

export async function verifyTaskCandidate(
  workspace: string, candidateCommit: string | null, check: TaskVerificationCheck,
  guest: VerificationGuest | undefined, signal?: AbortSignal,
): Promise<TaskVerificationResult> {
  if (!guest) return { check, candidateCommit, status: "error", output: "This Computer has no isolated verification guest." };
  if (!candidateCommit || candidateCommit !== await verificationCandidate(workspace, signal)) {
    return { check, candidateCommit, status: "error", output: "An unchanged local Git commit is required for verification." };
  }
  if (!commitPattern.test(check.commit) || typeof check.path !== "string" || check.path.length > 240
      || !check.path.split("/").every(part => pathComponent.test(part))) {
    return { check, candidateCommit, status: "error", output: "The required check definition is invalid." };
  }
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "relay-verification-"));
    const checkType = await git(workspace, ["cat-file", "-t", check.commit], 4096, signal);
    if (checkType.toString().trim() !== "commit") return { check, candidateCommit, status: "error", output: "The check revision must be a commit." };
    const script = await git(workspace, ["cat-file", "blob", `${check.commit}:${check.path}`], 64 * 1024, signal);
    if (!script.length) return { check, candidateCommit, status: "error", output: "The required check script is empty." };
    const snapshot = await candidatePack(workspace, candidateCommit, signal);
    await writeFile(join(directory, "check.sh"), script);
    await writeFile(join(directory, "candidate.pack"), snapshot);
    await writeFile(join(directory, "commit"), `${candidateCommit}\n`);
    const outcome = await guest(directory, signal);
    const output = [outcome.stderr, outcome.stdout, outcome.error_message].filter(Boolean).join("\n").slice(0, 4096);
    const status = outcome.exit_code === 0 ? "passed" : outcome.exit_code === 1 ? "failed" : "error";
    return { check, candidateCommit, status, output };
  } catch (error) {
    if (error instanceof ExecutionCleanupError) throw error;
    return { check, candidateCommit, status: "error", output: "The required check could not be prepared or run in its verification guest." };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
