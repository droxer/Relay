import { nativeWindowsExecution } from "./command-execution.js";

export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shellCommand(argv: string[]): string {
  if (nativeWindowsExecution()) return `await relayRun(${JSON.stringify(argv)})`;
  return `${argv.map(shellQuote).join(" ")} < /dev/null`;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
