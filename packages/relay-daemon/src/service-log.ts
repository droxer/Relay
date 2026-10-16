/**
 * Bounds `service.log`, the file launchd (macOS) and the Windows service host
 * append the daemon's output to; systemd's journal rotates itself. Writers hold
 * the file open in append mode, so it is copied aside and truncated in place
 * rather than renamed: an append after truncation lands at the new end.
 */
import { copyFileSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";

export const SERVICE_LOG_MAX_BYTES = 10 * 1024 * 1024;
const ROTATION_CHECK_MS = 10 * 60_000;

export function serviceLogPath(stateDir: string): string {
  return join(stateDir, "logs", "service.log");
}

/** Keeps one previous generation at `service.log.1`; true when it rotated. */
export function rotateServiceLog(file: string, maxBytes = SERVICE_LOG_MAX_BYTES): boolean {
  let size: number;
  try { size = statSync(file).size; } catch { return false; }
  if (size <= maxBytes) return false;
  copyFileSync(file, `${file}.1`);
  truncateSync(file, 0);
  return true;
}

/** Rotates now and periodically; the timer never keeps the process alive. */
export function watchServiceLog(file: string, warn: (message: string) => void): () => void {
  const check = (): void => {
    try { rotateServiceLog(file); } catch (error) {
      warn(`Cannot rotate ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  check();
  const timer = setInterval(check, ROTATION_CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
