export type AgentOutputSink = (text: string) => void;

const colorsEnabled = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);

export const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  // The web palette's three roles (palette.css, dark register) in 256-colour
  // codes, which every terminal Relay supports renders; 24-bit does not reach
  // macOS Terminal. Blue: an agent is working. Orange: a person is needed.
  // Crimson: something failed. Everything else stays default ink or dim.
  live: "\x1b[38;5;75m",
  action: "\x1b[38;5;208m",
  err: "\x1b[38;5;204m",
} as const;

export function color(text: string, ...codes: string[]): string {
  if (!colorsEnabled) return text;
  return `${codes.join("")}${text}${ansi.reset}`;
}

/** A section banner led by the mark's two chevrons: the action hands to the live. */
export function section(title: string): string {
  return `\n${color("›", ansi.bold, ansi.action)}${color("›", ansi.bold, ansi.live)} ${color(title, ansi.bold)}\n`;
}

export function status(kind: "ok" | "warn" | "error" | "info", message: string): string {
  const label = {
    ok: color("OK", ansi.bold),
    warn: color("WARN", ansi.action, ansi.bold),
    error: color("ERR", ansi.err, ansi.bold),
    info: color("INFO", ansi.dim),
  }[kind];
  return `${label}  ${message}`;
}

export function keyValue(key: string, value: string): string {
  return `${color(key.padEnd(11), ansi.dim)} ${value}`;
}

export function agentLabel(name: string, accent: string): string {
  return color(name, ansi.bold, accent);
}

export function indent(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export function emitOrPrint(sink: AgentOutputSink | undefined, text: string): void {
  if (sink) {
    sink(text.endsWith("\n") ? text : `${text}\n`);
  } else {
    console.log(text);
  }
}
