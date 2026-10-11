import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export type MachineIdSource = "explicit" | "file" | "generated" | "regenerated" | "fallback";

export interface MachineIdResolution {
  /** Stable identifier for the physical host, used as the daemon's workspaceId. */
  machineId: string;
  source: MachineIdSource;
  path?: string;
}

export interface MachineIdOptions {
  /** Hashed OS-level host id; injectable so tests can simulate a cloned home. */
  readHostFingerprint?: () => string | undefined;
}

const HOST_PROBE_TIMEOUT_MS = 2_000;

/**
 * Where the persisted per-host machine id lives. Deliberately keyed to the
 * host home directory — NOT the workspace — so it stays constant when the same
 * computer relaunches the daemon from a different working directory. A daemon
 * that changes directories must still resolve to one computer, otherwise every
 * relaunch mints a fresh compatibility agent and the roster fills with
 * duplicates.
 */
export function machineIdPath(home: string = homedir()): string {
  return join(home, ".relay", "machine-id");
}

/**
 * The host fingerprint the persisted id was minted on. A home directory copied
 * onto another machine (a cloned VM image, a migrated laptop) carries the id
 * file with it; without this the two machines would report one identity and
 * the backend would keep retiring one in favour of the other.
 */
export function hostFingerprintPath(home: string = homedir()): string {
  return join(home, ".relay", "machine-id.host");
}

export function readMachineId(home: string = homedir()): string | undefined {
  return readTrimmed(machineIdPath(home));
}

export function newMachineId(): string {
  return `mch_${randomBytes(16).toString("base64url")}`;
}

/**
 * A hash of the operating system's own host id (Linux /etc/machine-id, macOS
 * IOPlatformUUID, Windows MachineGuid). Hashed so the raw hardware id never
 * leaves the machine; undefined when the platform offers none.
 */
export function readHostFingerprint(): string | undefined {
  const raw = readOsHostId();
  return raw ? createHash("sha256").update(raw).digest("hex").slice(0, 32) : undefined;
}

/**
 * Resolve a stable, unique identity for this host, preferring an explicit
 * value, then a persisted id (unless it was minted on a different host), then
 * a freshly generated + persisted one. If the home directory cannot be
 * written, fall back to an id derived from the OS host id, and only then from
 * the hostname, so two runs on the same host still collapse to one computer.
 */
export function ensureMachineId(
  explicit?: string,
  home: string = homedir(),
  options: MachineIdOptions = {},
): MachineIdResolution {
  const provided = explicit?.trim();
  if (provided) {
    return { machineId: provided, source: "explicit" };
  }

  const fingerprint = (options.readHostFingerprint ?? readHostFingerprint)();
  const path = machineIdPath(home);
  try {
    // Writers publish the id before its fingerprint. Read in reverse order
    // so a new fingerprint cannot be paired with a previously read old id.
    const recorded = readFingerprint(home);
    const existing = readMachineId(home);
    if (existing && !(fingerprint && recorded && recorded !== fingerprint)) {
      if (fingerprint && !recorded) recordFingerprint(home, fingerprint);
      return { machineId: existing, source: "file", path };
    }
    mkdirSync(join(home, ".relay"), { recursive: true });
    const minted = existing && fingerprint
      ? { machineId: replaceMachineId(path, fingerprint), source: "regenerated" as const }
      : createMachineId(path);
    if (fingerprint) recordFingerprint(home, fingerprint);
    return { ...minted, path };
  } catch {
    const seed = fingerprint ?? sanitizeHostname(hostname());
    return { machineId: `host_${seed}`, source: "fallback" };
  }
}

/** Create the id file exclusively; a daemon that loses the race adopts the winner's id. */
function createMachineId(path: string): { machineId: string; source: MachineIdSource } {
  const generated = newMachineId();
  try {
    writeFileSync(path, `${generated}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    const winner = errorCode(error) === "EEXIST" ? readTrimmed(path) : undefined;
    if (winner) return { machineId: winner, source: "file" };
    throw error;
  }
  chmodSync(path, 0o600);
  return { machineId: generated, source: "generated" };
}

function replaceMachineId(path: string, fingerprint: string): string {
  // All daemons on the new host must choose the same replacement, even if
  // they read the old metadata together or a prior metadata write failed.
  const digest = createHash("sha256").update(`relay-machine-id:${fingerprint}`).digest().subarray(0, 16);
  const generated = `mch_${digest.toString("base64url")}`;
  writePrivate(path, generated);
  return generated;
}

function writePrivate(path: string, value: string): void {
  const temporary = `${path}.${newMachineId()}.tmp`;
  try {
    writeFileSync(temporary, `${value}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readFingerprint(home: string): string | undefined {
  try {
    return readTrimmed(hostFingerprintPath(home));
  } catch {
    // Missing or inaccessible clone-detection metadata must not discard a
    // readable machine id that threads and placements already refer to.
    return undefined;
  }
}

function recordFingerprint(home: string, fingerprint: string): void {
  try {
    writePrivate(hostFingerprintPath(home), fingerprint);
  } catch {
    // The machine id is authoritative; metadata persistence is best effort.
  }
}

function readTrimmed(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function readOsHostId(): string | undefined {
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], probeOptions());
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1];
    }
    if (process.platform === "win32") {
      const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], probeOptions());
      return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out)?.[1];
    }
  } catch {
    return undefined;
  }
  for (const candidate of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const value = readFileSync(candidate, "utf8").trim();
      if (value) return value;
    } catch {
      // Try the next location; containers often ship neither.
    }
  }
  return undefined;
}

function probeOptions() {
  return { encoding: "utf8" as const, timeout: HOST_PROBE_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
}

function sanitizeHostname(value: string): string {
  const safe = value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  return safe || "local";
}
