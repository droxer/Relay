/**
 * The shell a local computer runs agent scripts in. Every host-mode command is a
 * `bash -c` script, so Windows needs Git for Windows' bash — the same one
 * Claude Code itself requires there. WSL's `System32\bash.exe` is never used: it
 * runs scripts inside a Linux VM that cannot see the Windows agent installs.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

export const GIT_BASH_REQUIRED = "Relay on Windows needs Git for Windows (Git Bash). Install it from https://git-scm.com/download/win, or set RELAY_BASH_PATH to its bash.exe, then try again.";

export interface ShellLookup {
  env: NodeJS.ProcessEnv;
  exists(path: string): boolean;
  /** Absolute paths of `git.exe` on PATH, in PATH order. */
  gitOnPath(): string[];
}

function systemLookup(): ShellLookup {
  return {
    env: process.env,
    exists: existsSync,
    gitOnPath: () => {
      const result = spawnSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true });
      return result.status === 0 ? result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [];
    },
  };
}

function isWslBash(path: string): boolean {
  return /\\(system32|sysnative)\\bash\.exe$/i.test(win32.normalize(path));
}

/** Git Bash candidates, most explicit first; Git installs git.exe in `<root>\cmd` or `<root>\bin`. */
export function gitBashCandidates(lookup: ShellLookup): string[] {
  const { env } = lookup;
  const roots = [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"], env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs")]
    .filter((root): root is string => Boolean(root))
    .map(root => win32.join(root, "Git"));
  const fromGit = lookup.gitOnPath().map(git => win32.resolve(win32.dirname(git), ".."));
  return [
    env.RELAY_BASH_PATH,
    env.CLAUDE_CODE_GIT_BASH_PATH,
    ...[...fromGit, ...roots].map(root => win32.join(root, "bin", "bash.exe")),
  ].filter((path): path is string => Boolean(path));
}

let cached: string | undefined;

/** `bash` everywhere except Windows, where it is the resolved Git Bash or an explicit error. */
export function localBash(platform = process.platform, lookup?: ShellLookup): string {
  if (platform !== "win32") return "bash";
  if (!lookup && cached) return cached;
  const resolvedLookup = lookup ?? systemLookup();
  const found = gitBashCandidates(resolvedLookup).find(path => !isWslBash(path) && resolvedLookup.exists(path));
  if (!found) throw new Error(GIT_BASH_REQUIRED);
  if (!lookup) cached = found;
  return found;
}
