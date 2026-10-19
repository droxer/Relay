/**
 * Platform conditions the installer cannot fix itself but must not leave the
 * user to discover: each returns what to tell them, or undefined when none apply.
 */
import { isAbsolute, join, posix, relative } from 'node:path';
import { powershellLiteral } from './windows-service.js';

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

/** Whether `dir` is an entry of a PATH value, compared the way the platform resolves commands. */
export function isOnPath(dir: string, pathValue: string | undefined, platform: string): boolean {
  const windows = platform === 'win32';
  const normalize = (entry: string) => {
    const bare = entry.trim().replace(/^"(.*)"$/, '$1').replace(windows ? /[\\/]+$/ : /\/+$/, '');
    return windows ? bare.toLowerCase() : bare;
  };
  const target = normalize(dir);
  return (pathValue ?? '').split(windows ? ';' : ':').some(entry => entry && normalize(entry) === target);
}

interface LauncherDirectory {
  binDir: string;
  home: string;
  platform: string;
  /** The login shell (`$SHELL`), which decides the startup files it reads. */
  shell: string | undefined;
}

interface StartupFile {
  file: string;
  /** Read once per login: on Linux a change needs a new login; macOS terminals open login shells. */
  login: boolean;
}

/** The startup files a shell reads, the one to append to first. */
function startupFiles(platform: string, shell: string | undefined): StartupFile[] {
  switch (posix.basename(shell ?? '')) {
    case 'fish': return [];
    case 'zsh': return [{ file: '.zshrc', login: false }, { file: '.zprofile', login: true }];
    case 'bash': {
      const loginFiles = ['.bash_profile', '.bash_login', '.profile'].map(file => ({ file, login: true }));
      return platform === 'darwin'
        ? [...loginFiles, { file: '.bashrc', login: false }]
        : [{ file: '.bashrc', login: false }, ...loginFiles];
    }
    default: return [{ file: '.profile', login: true }];
  }
}

function homeOffset(home: string, dir: string): string | undefined {
  const offset = posix.relative(home, dir);
  return offset !== '' && !offset.startsWith('..') && !posix.isAbsolute(offset) ? offset : undefined;
}

/** Recognize simple PATH assignments only; uncertain shell code gets the explicit fix instead. */
function addsDirectory(content: string, home: string, dir: string): boolean {
  return content.split('\n').some(line => {
    const assignment = /^\s*(?:export[ \t]+)?PATH=(?:"([^"\\`]*)"|'([^']*)'|([^\s"'\\`#;]+))[ \t]*(?:#.*)?$/.exec(line);
    if (!assignment) return false;
    const [, doubleQuoted, singleQuoted, unquoted] = assignment;
    let value = doubleQuoted ?? singleQuoted ?? unquoted!;
    if (singleQuoted === undefined) {
      value = value.replace(/\$\{HOME\}|\$HOME(?=\/|:|$)/g, () => home);
    }
    if (unquoted !== undefined) value = value.replace(/(^|:)~(?=\/)/g, (_match, prefix: string) => `${prefix}${home}`);
    return value.split(':').includes(dir);
  });
}

/**
 * The startup file (`~/…`) that already puts `binDir` on PATH — as Debian and Ubuntu's default
 * `~/.profile` does once `~/.local/bin` exists — though this session started before it did.
 */
export function startupFileAddingDir(options: LauncherDirectory, read: (file: string) => string | undefined): string | undefined {
  if (options.platform === 'win32') return undefined;
  const files = startupFiles(options.platform, options.shell).map(file => ({
    ...file, content: read(posix.join(options.home, file.file)),
  }));
  // Bash reads only the first existing login profile, even when that file is empty.
  const bash = posix.basename(options.shell ?? '') === 'bash';
  const loginFile = files.find(file => file.login && file.content !== undefined);
  const found = files.find(file => {
    if (bash && file.login && file !== loginFile) return false;
    return file.content !== undefined && addsDirectory(file.content, options.home, options.binDir);
  });
  return found && `~/${found.file}`;
}

interface PathNoticeOptions extends LauncherDirectory {
  command: string;
  /** A startup file that already adds `binDir`, from `startupFileAddingDir`. */
  configuredIn?: string;
}

/** The launcher directory is not on PATH: say so, and give the one step that fixes it. */
export function pathNotice(options: PathNoticeOptions): string {
  const { binDir, command, platform, configuredIn } = options;
  const lead = `${binDir} is not on your PATH, so \`${command}\` does not run by name yet.`;
  if (platform === 'win32') {
    const entry = powershellLiteral(`${binDir};`);
    return [
      `${lead} To add it, run once in PowerShell:`,
      `  [Environment]::SetEnvironmentVariable('Path', ${entry} + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')`,
      'Then open a new terminal.',
    ].join('\n');
  }
  const files = startupFiles(platform, options.shell);
  if (configuredIn) {
    const login = files.find(({ file }) => `~/${file}` === configuredIn)?.login ?? true;
    const reload = login && platform !== 'darwin' ? 'log out and back in' : 'open a new terminal';
    return `${lead} ${configuredIn} already adds it now that it exists; ${reload} to pick it up.`;
  }
  const offset = homeOffset(options.home, binDir);
  if (files.length === 0) {
    const dir = offset ? `~/${offset}` : shellQuote(binDir);
    return [`${lead} To add it, run once:`, `  fish_add_path ${dir}`, 'Then open a new terminal.'].join('\n');
  }
  const startupFile = `~/${files[0]!.file}`;
  const dir = offset ? `$HOME/${offset}` : binDir.replace(/[\\"$`]/g, '\\$&');
  return [
    `${lead} To add it, run once:`,
    `  echo ${shellQuote(`export PATH="${dir}:$PATH"`)} >> ${startupFile}`,
    `Then open a new terminal, or run: source ${startupFile}`,
  ].join('\n');
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
