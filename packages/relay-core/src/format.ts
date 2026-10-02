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
  brand: "\x1b[38;5;173m",
} as const;

export function color(text: string, ...codes: string[]): string {
  if (!colorsEnabled) return text;
  return `${codes.join("")}${text}${ansi.reset}`;
}

export function section(title: string, accent: string): string {
  return `\n${color(`== ${title} `, ansi.bold, accent)}${color("=".repeat(Math.max(8, 58 - title.length)), accent)}\n`;
}

export function status(kind: "ok" | "warn" | "error" | "info", message: string): string {
  const label = {
    ok: color("OK", ansi.green, ansi.bold),
    warn: color("WARN", ansi.yellow, ansi.bold),
    error: color("ERR", ansi.red, ansi.bold),
    info: color("INFO", ansi.cyan, ansi.bold),
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
