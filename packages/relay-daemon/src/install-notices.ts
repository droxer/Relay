/**
 * Platform conditions the installer cannot fix itself but must not leave the
 * user to discover: each returns what to tell them, or undefined when none apply.
 */
import { isAbsolute, join, relative } from 'node:path';

/**
 * macOS privacy protection (TCC) guards these folders per app. The installer's
 * checks ran with the terminal's permission, but the background service runs as
 * `node` and is asked again — or denied, if nobody is at the screen.
 */
export function macProtectedFolder(home: string, workspace: string): string | undefined {
  const protectedFolders: Array<[string, string]> = [
    ['Desktop', join(home, 'Desktop')],
    ['Documents', join(home, 'Documents')],
    ['Downloads', join(home, 'Downloads')],
    ['iCloud Drive', join(home, 'Library', 'Mobile Documents')],
    ['a cloud storage folder', join(home, 'Library', 'CloudStorage')],
    ['an external volume', '/Volumes'],
  ];
  return protectedFolders.find(([, folder]) => isWithin(folder, workspace))?.[0];
}

export function macProtectedFolderNotice(folder: string, product: string): string {
  return [
    `Your workspace is in ${folder}, which macOS protects per app.`,
    `When ${product} first opens it in the background, macOS asks whether "node" may access ${folder}; choose Allow.`,
    'If no prompt appears and runs fail with "Operation not permitted", allow node under System Settings → Privacy & Security → Files and Folders,',
    'or reinstall with a workspace outside these folders.',
  ].join('\n');
}

function isWithin(folder: string, path: string): boolean {
  const offset = relative(folder, path);
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset));
}

/** `loginctl show-user -p Linger --value` prints `no` while systemd stops user services at logout. */
export function lingerNotice(linger: string | undefined, user: string, product: string): string | undefined {
  if (linger?.trim() !== 'no') return undefined;
  return [
    `${product} stops when you log out and starts again at your next login.`,
    'To keep it running without a login (for example on a server you reach over SSH), run once:',
    `  sudo loginctl enable-linger ${user}`,
  ].join('\n');
}

/** Why `launchctl bootstrap gui/<uid>` failed, in terms of what to do next. */
export function launchdBootstrapError(env: NodeJS.ProcessEnv, product: string): string {
  if (env.SSH_CONNECTION || env.SSH_TTY) {
    return `macOS starts ${product} in the background only from a session on the Mac's own screen; over SSH there is none.\n`
      + 'Run the install command in Terminal on the Mac, or re-run it here with --foreground to run in this terminal.';
  }
  return `macOS could not start the ${product} service (launchctl bootstrap failed). Run the install command again; if it keeps failing, re-run it with --foreground.`;
}
