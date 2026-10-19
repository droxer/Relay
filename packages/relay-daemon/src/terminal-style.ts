/**
 * Semantic styling for what the daemon package prints to a person: the installer, the control
 * CLI, `--doctor`, and the daemon's own lifecycle lines. Color only reaches a terminal; a
 * service log, a pipe, or `NO_COLOR` gets the exact plain text, with no marks added, so nothing
 * machine-read changes.
 */
import { ansi } from 'relay-core';

export interface TerminalStyle {
  /** A finished step: `✓ Connected to Relay.` */
  success(text: string): string;
  /** A step in progress or a neutral fact. */
  step(text: string): string;
  /** Something the user should act on; the first line is the headline. */
  warn(text: string): string;
  /** A failure; the first line is the headline. */
  error(text: string): string;
  heading(text: string): string;
  /** A command or path the user copies. */
  command(text: string): string;
  link(text: string): string;
  /** Secondary detail such as a label or a log path. */
  muted(text: string): string;
  /** A multi-line notice: a warning headline, then its indented commands highlighted. */
  notice(text: string): string;
  /** A passing or failing status word such as `OK` / `FAIL`, colored but unmarked. */
  verdict(text: string, ok: boolean): string;
}

interface StreamLike { isTTY?: boolean }

/** Whether a stream gets color: a terminal, unless `NO_COLOR`; `FORCE_COLOR` forces it on or off. */
export function colorEnabled(stream: StreamLike, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  return Boolean(stream.isTTY) && env.TERM !== 'dumb';
}

/** Legacy Windows consoles lack these glyphs; Windows Terminal (`WT_SESSION`) has them. */
function glyphs(platform: string, env: NodeJS.ProcessEnv): { ok: string; warn: string; error: string; step: string } {
  return platform === 'win32' && !env.WT_SESSION
    ? { ok: '+', warn: '!', error: 'x', step: '>' }
    : { ok: '✓', warn: '!', error: '✗', step: '›' };
}

export function terminalStyle(enabled: boolean, platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): TerminalStyle {
  const paint = (text: string, ...codes: string[]) => enabled && text ? `${codes.join('')}${text}${ansi.reset}` : text;
  const mark = glyphs(platform, env);
  // Marks ride with color: plain output stays byte-for-byte what it always was.
  const marked = (glyph: string, text: string) => enabled ? `${glyph} ${text}` : text;
  const headline = (text: string, glyph: string, ...codes: string[]) => {
    const [first = '', ...rest] = text.split('\n');
    return [paint(marked(glyph, first), ansi.bold, ...codes), ...rest].join('\n');
  };
  return {
    success: text => enabled ? `${paint(mark.ok, ansi.bold, ansi.green)} ${paint(text, ansi.bold)}` : text,
    step: text => enabled ? `${paint(mark.step, ansi.cyan)} ${text}` : text,
    warn: text => headline(text, mark.warn, ansi.yellow),
    error: text => headline(text, mark.error, ansi.red),
    heading: text => paint(text, ansi.bold),
    command: text => paint(text, ansi.cyan),
    link: text => paint(text, ansi.cyan, '\x1b[4m'),
    muted: text => paint(text, ansi.dim),
    notice: text => {
      const [first = '', ...rest] = text.split('\n');
      const body = rest.map(line => line.startsWith('  ') ? `  ${paint(line.slice(2), ansi.cyan)}` : line);
      return [paint(marked(mark.warn, first), ansi.bold, ansi.yellow), ...body].join('\n');
    },
    verdict: (text, ok) => paint(text, ansi.bold, ok ? ansi.green : ansi.red),
  };
}

/** Styles for standard output and standard error, each colored only when it is a terminal. */
export const out = terminalStyle(colorEnabled(process.stdout));
export const err = terminalStyle(colorEnabled(process.stderr));
